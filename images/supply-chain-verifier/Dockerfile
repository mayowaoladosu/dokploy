# syntax=docker/dockerfile:1
FROM anchore/syft@sha256:1288ea4c8b38767b4e620c1e312c8cb26b6e887a99b4f07ab6cd19fc6f225026 AS syft
FROM aquasec/trivy@sha256:7cced7cae583819fc7806d4cbc0dbbc7cad18b99f7d3e235192e6da8c091045c AS trivy
FROM ghcr.io/sigstore/cosign/cosign@sha256:b29487e48205d875c324c79583e2806d9d269c0fa299e0861bbec023d8430c8b AS cosign

FROM alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce

RUN apk add --no-cache \
	ca-certificates \
	coreutils \
	docker-cli \
	jq \
	skopeo

COPY --from=syft /syft /usr/local/bin/syft
COPY --from=trivy /usr/local/bin/trivy /usr/local/bin/trivy
COPY --from=cosign /ko-app/cosign /usr/local/bin/cosign

RUN for tool in docker skopeo syft trivy cosign jq sha256sum cut; do \
		command -v "$tool" >/dev/null || exit 1; \
		"$tool" --version >/dev/null; \
	done \
	&& install -d -o 65532 -g 65532 /home/verifier

ENV HOME=/home/verifier
USER 65532:65532
