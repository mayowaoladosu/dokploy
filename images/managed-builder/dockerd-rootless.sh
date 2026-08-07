#!/bin/sh
set -eu

exec /usr/local/bin/dockerd-entrypoint.sh dockerd "$@"
