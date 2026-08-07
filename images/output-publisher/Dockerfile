# syntax=docker/dockerfile:1
FROM rclone/rclone@sha256:b06aed988cf5967de7c25be5925240983981c757f4ed1ac9d2fa659d51d60548 AS rclone

FROM alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce

RUN apk add --no-cache \
	ca-certificates \
	coreutils \
	findutils \
	gawk \
	jq

COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone

RUN for tool in rclone jq sha256sum find awk wc; do \
		command -v "$tool" >/dev/null || exit 1; \
	done \
	&& rclone version \
	&& install -d -o 65532 -g 65532 /home/publisher

ENV HOME=/home/publisher
USER 65532:65532
