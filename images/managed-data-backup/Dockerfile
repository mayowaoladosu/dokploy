# syntax=docker/dockerfile:1
FROM rclone/rclone@sha256:b06aed988cf5967de7c25be5925240983981c757f4ed1ac9d2fa659d51d60548 AS rclone

# The managed product surface currently exposes PostgreSQL only. PostgreSQL 18
# client tools can back up and restore supported older PostgreSQL server versions.
FROM postgres:18-bookworm@sha256:882236b897e39051d2368c5ccc6cda944904723506b2dfc97f2a8f5bc9afa382

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates \
		coreutils \
		gzip \
		jq \
		tar \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone

RUN for tool in rclone sha256sum stat jq tar gzip pg_dump pg_restore psql; do \
		command -v "$tool" >/dev/null || exit 1; \
	done \
	&& rclone version \
	&& pg_dump --version \
	&& install -d -o 65532 -g 65532 /home/backup /backup

ENV HOME=/home/backup
USER 65532:65532
