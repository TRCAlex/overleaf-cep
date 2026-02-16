FROM overleafcep/sharelatex:6.1.1-ext-v3.5 

# Install K8s client
WORKDIR /overleaf/services/clsi
RUN npm install @kubernetes/client-node@^0.21.0 --omit=dev

# Copy your modified files
COPY services/clsi/app/js/KubernetesRunner.js /overleaf/services/clsi/app/js/KubernetesRunner.js
COPY services/clsi/app/js/CommandRunner.js /overleaf/services/clsi/app/js/CommandRunner.js
COPY services/clsi/config/settings.defaults.js /overleaf/services/clsi/config/settings.defaults.js

# Back to original working directory
WORKDIR /overleaf

EXPOSE map[80/tcp:{}]
ENTRYPOINT ["/sbin/my_init"]
RUN /bin/sh -c node genScript compile | bash
