FROM overleafcep/sharelatex:6.1.1-ext-v3.5 

# Install K8s client
WORKDIR /overleaf/services/clsi
RUN npm install @kubernetes/client-node@^0.21.0 --omit=dev

# Copy modified files
COPY services/clsi/app/js/KubernetesRunner.js /overleaf/services/clsi/app/js/KubernetesRunner.js
COPY services/clsi/app/js/CommandRunner.js /overleaf/services/clsi/app/js/CommandRunner.js
COPY services/clsi/config/settings.defaults.js /overleaf/services/clsi/config/settings.defaults.js
# COPY server-ce/runit/clsi-overleaf/run /etc/service/clsi-overleaf/run

# Back to original working directory
WORKDIR /overleaf

# NEEDED FOR NFS USAGE
# # Commenting out docker-legacy lines and unnecessary root lines
#RUN sed -i 's/^chown/#&/' /etc/my_init.d/100_make_overleaf_data_dirs.sh
RUN sed -i 's/^echo "$(route.*dockerhost/#&/' /etc/my_init.d/100_set_docker_host_ipaddress.sh
RUN sed -i '/^#/! s/.*/#&/' /etc/my_init.d/10_syslog-ng.init

# RUN sed -i 's|tee -a "$LOG_FILE"|/sbin/setuser www-data &|' /etc/my_init.d/910_initiate_doc_version_recovery

# # Changing config to work with non-root user
# RUN sed -i 's|pid /run/nginx.pid;|pid /var/lib/nginx/nginx.pid;|' /etc/nginx/templates/nginx.conf.template
# RUN sed -i 's|sendfile on;|server{listen 8080;}\n        sendfile on;|' /etc/nginx/templates/nginx.conf.template
# RUN sed -i 's|listen         80;|listen         8080;|' /etc/nginx/sites-enabled/overleaf.conf
# RUN sed -i 's|^/sbin/setuser www-data ||' /etc/my_init.d/500_check_db_access.sh
# RUN sed -i 's|^/sbin/setuser www-data ||' /etc/my_init.d/900_run_web_migrations.sh
# RUN sed -i 's|^/sbin/setuser www-data ||' /etc/my_init.d/910_check_texlive_images
# RUN sed -i 's|/sbin/setuser www-data ||' /etc/my_init.d/910_initiate_doc_version_recovery
# # Change ownership to non-root to allow read-write
# RUN chown -R 33:33 /etc/nginx
# RUN chown -R 33:33 /var/lib/nginx
# RUN chown -R 33:33 /etc/container_environment
# RUN touch /etc/container_environment.sh && chown -R 33:33 /etc/container_environment.sh
# RUN touch /etc/container_environment.json && chown -R 33:33 /etc/container_environment.json
# #RUN chmod -R a+rwX /etc/container_environment


# USER 33

# EXPOSE map[8080/tcp:{}]

EXPOSE map[80/tcp:{}]
ENTRYPOINT ["/sbin/my_init"]
RUN /bin/sh -c node genScript compile | bash
