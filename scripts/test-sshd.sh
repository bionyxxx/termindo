#!/usr/bin/env bash
# Start a throwaway OpenSSH server for integration tests and print the env var to use.
set -euo pipefail
NAME=termindo-test-sshd
PORT=${PORT:-2222}
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -p "$PORT:2222" \
  -e PUID=1000 -e PGID=1000 -e USER_NAME=tester -e USER_PASSWORD=termindo-test \
  -e PASSWORD_ACCESS=true \
  lscr.io/linuxserver/openssh-server:latest >/dev/null
for _ in $(seq 1 30); do
  if docker logs "$NAME" 2>&1 | grep -q "Server listening\|sshd is listening\|done"; then break; fi
  sleep 1
done
sleep 2
echo "export TERMINDO_TEST_SSH=127.0.0.1:$PORT:tester:termindo-test"
echo "# stop with: docker rm -f $NAME"
