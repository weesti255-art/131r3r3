# PostgreSQL with MailControl's role scripts baked in: no host bind mounts,
# which Docker Desktop does not always deliver into the container.
FROM postgres:16-bookworm
COPY 20-app-role.sql /docker-entrypoint-initdb.d/20-app-role.sql
COPY sync-app-role.sh after-restore.sql /mailcontrol/
COPY entrypoint.sh /usr/local/bin/mailcontrol-entrypoint.sh
# Tolerate CRLF if the sources were checked out or edited on Windows.
RUN sed -i 's/\r$//' /mailcontrol/sync-app-role.sh /mailcontrol/after-restore.sql \
      /docker-entrypoint-initdb.d/20-app-role.sql /usr/local/bin/mailcontrol-entrypoint.sh \
 && chmod 755 /mailcontrol /usr/local/bin/mailcontrol-entrypoint.sh /mailcontrol/sync-app-role.sh \
 && chmod 644 /mailcontrol/after-restore.sql /docker-entrypoint-initdb.d/20-app-role.sql
ENTRYPOINT ["mailcontrol-entrypoint.sh"]
CMD ["postgres"]
