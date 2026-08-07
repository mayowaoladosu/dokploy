# syntax=docker/dockerfile:1
FROM buildpacksio/pack:0.39.1@sha256:c54fdac6b8e65c272849bf549aea61122746d59b01e6e06db5da654c7e4f5acb AS pack
FROM docker:29-dind-rootless@sha256:7451e3dc398b11ba2d8183bb7915402683e3d32e5ec8cef835c215f314a65fef

USER root

RUN apk add --no-cache \
	bash \
	ca-certificates \
	coreutils \
	curl \
	findutils \
	git \
	git-lfs \
	jq \
	nodejs \
	npm \
	openssh-client \
	rsync \
	tar \
	unzip \
	zip \
	&& git lfs install --system

COPY --from=pack /usr/local/bin/pack /usr/local/bin/pack
COPY --chmod=0755 dockerd-rootless.sh /usr/local/bin/dockerd-rootless.sh

ARG NIXPACKS_VERSION=1.41.0
RUN curl -fsSL https://nixpacks.com/install.sh -o /tmp/install-nixpacks.sh \
	&& NIXPACKS_VERSION="${NIXPACKS_VERSION}" bash /tmp/install-nixpacks.sh --yes \
	&& rm /tmp/install-nixpacks.sh \
	&& nixpacks --version

ARG RAILPACK_VERSION=0.15.4
RUN curl -fsSL https://railpack.com/install.sh -o /tmp/install-railpack.sh \
	&& RAILPACK_VERSION="${RAILPACK_VERSION}" bash /tmp/install-railpack.sh --yes \
	&& rm /tmp/install-railpack.sh \
	&& railpack --version

RUN install -d -o rootless -g rootless /home/builder

ENV HOME=/home/builder \
	DOCKERD_ROOTLESS_ROOTLESSKIT_NET=slirp4netns \
	DOCKERD_ROOTLESS_ROOTLESSKIT_FLAGS=--port-driver=builtin
USER 1000:1000

RUN for tool in node base64 jq sha256sum find tar docker dockerd-rootless.sh fuse-overlayfs nixpacks railpack pack; do \
		command -v "$tool" >/dev/null || { echo "Missing managed builder tool: $tool"; exit 1; }; \
	done \
	&& docker --version \
	&& docker buildx version
