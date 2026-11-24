#!/usr/bin/env bash
# Pull the newest server image and restart the stack. Run from the deploy/ directory.
set -euo pipefail
cd "$(dirname "$0")"
docker compose --profile tls pull
docker compose --profile tls up -d --remove-orphans
docker image prune -f >/dev/null
docker compose --profile tls ps
