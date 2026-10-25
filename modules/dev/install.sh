#!/usr/bin/env bash
set -e

HERE="$(dirname "${BASH_SOURCE[0]}")"
bash "$HERE/docker.sh"
bash "$HERE/uv.sh"
