const { promisify } = require('node:util')
const Settings = require('@overleaf/settings')
const logger = require('@overleaf/logger')
const Kubernetes = require('@kubernetes/client-node')
const crypto = require('node:crypto')
const async = require('async')
const LockManager = require('./DockerLockManager')
const Path = require('node:path')
const fs = require('fs')
const _ = require('lodash')
const os = require('os')

const ONE_HOUR_IN_MS = 60 * 60 * 1000
logger.debug('using kubernetes runner')

const KubernetesRunner = {
  init() {
    const kubeconfig = new Kubernetes.KubeConfig();
    try {
      logger.info('Loading in-cluster config')
      console.log(process.getuid?.())
      kubeconfig.loadFromCluster();

      this.namespace = fs.readFileSync(
        '/var/run/secrets/kubernetes.io/serviceaccount/namespace',
        'utf8'
      ).trim();
    } catch (e) {
      logger.warn('Failed to load in-cluster config, trying default');
      kubeconfig.loadFromDefault();
      this.namespace = 'default';
    }

    this.batchApi = kubeconfig.makeApiClient(Kubernetes.BatchV1Api);
    this.coreApi = kubeconfig.makeApiClient(Kubernetes.CoreV1Api);
    this._initialized = true;
    this.seLinuxLevel = null

    // Load SELinux config
    this._loadSELinuxConfig()
      .then(() => {
        logger.info({ seLinuxLevel: this.seLinuxLevel }, 'SELinux config ready')
      })
      .catch(err => {
        logger.warn({ err }, 'Could not load SELinux config')
      })
  },

  _ensureInit() {
    if (!this._initialized) {
      this.init();
    }
  },

  run(projectId, command, directory, image, timeout, environment, compileGroup, callback) {
    command = command.map(arg =>
      arg.toString().replace('$COMPILE_DIR', `/compiles`) // Check to sync with compileDir in options()
    )

    if (image == null) {
      image = Settings.clsi.k8s.image
    }

    if (
      Settings.clsi.k8s.allowedImages &&
      !Settings.clsi.k8s.allowedImages.includes(image)
    ) {
      return callback(new Error('image not allowed'))
    }

    if (Settings.texliveImageNameOveride != null) {
      const img = Path.basename(image)
      image = `${Settings.texliveImageNameOveride}/${img}`
    }

    if (compileGroup === 'synctex-output') {
      // In: directory = '/overleaf/services/clsi/output/projectId-userId/generated-files/buildId'
      //             directory.split('/').slice(-3) === 'projectId-userId/generated-files/buildId'
      //  sandboxedCompilesHostDirOutput = '/host/output'
      // Out:                  directory = '/host/output/projectId-userId/generated-files/buildId'
      directory = Path.join(
        Settings.path.sandboxedCompilesHostDirOutput,
        ...directory.split('/').slice(-3)
      )
    } else {
      // In:   directory = '/overleaf/services/clsi/compiles/projectId-userId'
      //                       Path.basename(directory) === 'projectId-userId'
      //  sandboxedCompilesHostDirCompiles = '/host/compiles'
      // Out:                    directory = '/host/compiles/projectId-userId'
      directory = Path.join(
        Settings.path.sandboxedCompilesHostDirCompiles,
        Path.basename(directory)
      )
    }

    KubernetesRunner._ensureInit()
    logger.info({ projectId }, 'KubernetesRunner: starting compile job');

    const options = KubernetesRunner._getJobOptions(
      command,
      image,
      timeout,
      environment,
      compileGroup
    )

    const fingerprint = KubernetesRunner._fingerprintJob(options)
    const name = `project-${projectId}-${fingerprint}`.toLowerCase().substring(0, 63);
    options.name = name
    options.projectId = projectId
    options.directory = directory

    // logOptions = _.clone(options)
    // logOptions?.HostConfig?.SecurityOpt = "secomp used, removed in logging"
    logger.debug({ projectId }, 'running kubernetes job')
    KubernetesRunner._runAndWaitForJob(
      options,
      timeout,
      (error, output) => {
        if (error && error.statusCode === 500) {
          logger.debug(
            { err: error, projectId },
            'error running job so destroying and retrying'
          )
          KubernetesRunner.destroyJob(name, error => {
            if (error != null) {
              return callback(error)
            }
            KubernetesRunner._runAndWaitForJob(
              options,
              timeout,
              callback
            )
          })
        } else {
          callback(error, output)
        }
      }
    )

    return name
  },

  kill(name, callback) {
    this._ensureInit()
    logger.debug({ name }, 'sending kill signal to job')
    this.destroyJob(name)
  },

  async _runAndWaitForJob(options, timeout, _callback) {
    const callback = _.once(_callback)
    const { name, projectId } = options

    try {

      logger.info({ name }, 'Creating K8s job');
      this.runJob(options)

      const podName = await this._waitForJob(name);
      logger.info({ podName, timeout }, 'Pod found, waiting for completion')
      const exitCode = await this._waitForCompletion(podName);

      const logs = await this._getLogs(podName);

      this.destroyJob(name, (err) => {
        if (err) {
          logger.warn({ err, name }, 'Failed to destroy job after compile')
        } else {
          logger.debug({ name }, 'Job cleaned up after compile')
        }
      })

      callback(null, {
        exitCode: exitCode,
        stdout: logs,
        stderr: ''
      })

    } catch (error) {
      logger.error({ error, projectId }, 'KubernetesRunner error');
      callback(error);
    }
  },

  runJob(options, callback) {
    LockManager.runWithLock(
      options.name,
      releaseLock => KubernetesRunner._runJob(options, releaseLock),
      callback
    )
  },

  async _runJob(options, callback) {
    const { name } = options
    const { projectId } = options
    // VOLUMES
    const mountPath = "/compiles/"
    const subPath = options.directory
    //const subPath = `data/compiles/`${projectId}`

    const job = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: name,
        namespace: this.namespace,
        labels: {
          app: 'overleaf-compile',
          stack: 'overleaf',
          projectId: projectId
        }
      },
      spec: {
        ttlSecondsAfterFinished: 60,
        backoffLimit: 0,
        template: {
          spec: {
            restartPolicy: 'Never',
            securityContext: {
              fsGroupChangePolicy: "Always", 
              fsGroup: 33, 
              seLinuxOptions: {
                level: options.seLinuxLevel
              }},
            serviceAccountName: 'overleaf', // get account from current pod or from env variable
            containers: [{
              name: 'overleaf-compile',
              image: options.Image,
              command: ['/bin/sh', '-c'],
              args: [options.Cmd.join(' ')],
              //args: ['echo "Hello"; sleep 10; echo "Bye!"'],
              env: options.Env ? options.Env.map(envString => {
                const [key, ...valueParts] = envString.split('=');
                return { name: key, value: valueParts.join('=') };
              }) : [],
              resources: {
                limits: {
                  memory: options.MemoryLimit,
                  cpu: '1'
                }
              },
              volumeMounts: [{name: "overleaf-data", mountPath: mountPath, subPath: subPath}]
            }],
            volumes:[{name: "overleaf-data", persistentVolumeClaim: {claimName: options.VolumeClaim}}]
          }
        }
      }
    };

    try {
      const createResponse = await this.batchApi.createNamespacedJob(this.namespace, job);
      logger.info({ name, statuscode: createResponse.response?.statusCode }, 'Job created successfully')
      callback(null)
    } catch(err) {
      logger.error({ err, name, statusCode: err?.response?.statusCode }, 'Failed to create job')
      callback(err)
    }
  },

  async _waitForJob(name, maxWaitSeconds = 300) { 
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitSeconds * 1000) {
      try{
        const pods = await this.coreApi.listNamespacedPod(
          this.namespace,
          undefined, undefined, undefined, undefined,
          `job-name=${name}`
        );

        if (pods.body.items.length > 0) {
          return pods.body.items[0].metadata.name;
        }
      } catch (error) {
        logger.warn({ error, name}, 'Error waiting for pod');
      }

      await this._sleep(500)
    }

    throw new Error(`Pod for job ${name} has not been created`);
  },

  async _waitForCompletion(podName, timeoutMs = 300000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs){
      const pod = await this.coreApi.readNamespacedPodStatus(podName, this.namespace);
      const phase = pod.body.status.phase;
      const containerStatuses = pod.body.status.containerStatuses || [];

      // Pod Successfull
      if (phase === 'Succeeded') {
        return 0;
      }

      // Pod Failed
      if (phase === 'Failed') {
        // Check for OOMKilled, etc
        const terminated = containerStatuses[0]?.state?.terminated;
        return terminated?.exitCode || 1;
      }

      // Check for container crash
      const waiting = containerStatuses[0]?.state?.waiting;
      if (waiting?.reason === 'CrashLoopBackOff') {
        throw new Error(`Pod failed: ${waiting.reason}`);
      }

      // Something causes the image to fail being pulled, but on retry it succeeds.
      // NEEDS TO BE REFINED
      if (waiting?.reason === 'ImagePullBackOff') {
        logger.warn({ podName }, 'Image pull backing off, waiting for K8s retry...')
      }

      await this._sleep(1000);
    }
    throw new Error(`Compilation time out after ${timeoutMS}ms`)
  },

  async _getLogs(podName) {
    const response = await this.coreApi.readNamespacedPodLog(podName, this.namespace);
    logger.info({ podName }, "Retrieved logs");
    return response.body
  },

  _getJobOptions(
    command,
    image,
    timeout,
    environment,
    compileGroup
  ) {
    const timeoutInSeconds = timeout / 1000

    //merge settings and environment parameter
    const env = {}
    for (const src of [Settings.clsi.k8s.env, environment || {}]) {
      for ( const key in src) {
        const value = src[key]
        env[key] = value
      }
    }
    // set path based on image year
    const match = image.match(/:([0-9]+)\.[0-9]+|:TL([0-9]+)/)
    // rolling build does not follow our <year>.<version>.<patch> convention
    const year = match ? match[1] || match[2] : 'rolling'

    // read selinuxoptions from pod security context
    // needed for mapping volumes to multiple containers
    //const seLinuxLevel = process.env.SELINUX_OPTIONS_LEVEL
    env.PATH = `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/texlive/${year}/bin/x86_64-linux/`
    const options = {
      Cmd: command,
      Image: image,
      VolumeClaim: Settings.clsi.k8s.volumeClaim,
      compilePath: '/compiles',
      MemoryLimit: '1Gi', // 1 Gb
      User: Settings.clsi.k8s.user,
      Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
      seLinuxLevel: `${this.seLinuxLevel}`
    }

    // Allow per-compile group overriding of individual settings
    if (
      Settings.clsi.k8s.compileGroupConfig && 
      Settings.clsi.k8s.compileGroupConfig[compileGroup]
    ) {
      const override = Settings.clsi.k8s.compileGroupConfig[compileGroup]
      for (const key in override) {
        _.set(options, key, override[key])
      }
    }

    return options
  },

  async _loadSELinuxConfig() {
    try {
      const overleafPodName = process.env.POD_NAME || os.hostname() // environment variable is  not scalable!!
      const pod = await this.coreApi.readNamespacedPod(overleafPodName, this.namespace);
      this.seLinuxLevel = pod.body.spec?.securityContext?.seLinuxOptions?.level || pod.body.spec?.containers[0]?.securityContext?.seLinuxOptions?.level;
      logger.info({ seLinuxLevel: this.seLinuxLevel }, 'Loaded SELinux config from parent pod');
    } catch (err) {
      logger.warn({ err }, 'Could not load SELinux config, jobs may fail');
    }
  },

  _fingerprintJob(jobOptions) {
    const json = JSON.stringify(jobOptions)
    return crypto.createHash('md5').update(json).digest('hex')
  },

  destroyJob(name, callback) {
    LockManager.runWithLock(
      name,
      releaseLock => KubernetesRunner._destroyJob(name, releaseLock),
      callback || ((err) => {  // Default callback if none provided
        if (err) logger.warn({ err, name }, 'Failed to destroy job')
      })
    )
  },

  async _destroyJob(name, callback) {
    let err = null
    try {
      logger.debug({ name }, 'Destroying job')
      await this.batchApi.deleteNamespacedJob(
        name,
        this.namespace,
        undefined, undefined, undefined, undefined, undefined,
        { propagationPolicy: 'Background' }
      )
      logger.info({ name }, 'Job destroyed successfully.')
    } catch(e) {
      const status = 
        e?.response?.statusCode ??
        e?.statusCode ??
        e?.status ??
        e?.body?.code;

      if (status === 404) {
        logger.info({ name }, 'Job not found. Continuing.')
        err = null
      } else {
        logger.warn({ error: e, name }, 'ERROR destroying job')
        err = e
      }
    } finally {
      try {
        callback(err)
      } catch (releaseErr) {
        logger.error({ error: releaseErr, name }, 'Failed to release lock')
      }
    }
  },

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Initialise k8s config
KubernetesRunner.init()

module.exports = KubernetesRunner;
module.exports.promises = {
  run: promisify(KubernetesRunner.run),
  kill: promisify(KubernetesRunner.kill)
}