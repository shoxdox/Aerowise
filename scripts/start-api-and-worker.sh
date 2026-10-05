#!/bin/sh
# Runs the API and the worker in one container, for hosts where they must share a disk
# (uploaded photos and report PDFs live in FILE_STORAGE_DIR unless Cloudflare R2 is configured).
# If either process stops, the other is stopped and the container exits, so the host
# restarts both. The API's /health also checks the worker (HEALTH_INCLUDES_WORKER=true).
set -u
cd "$(dirname "$0")/.."

(cd apps/api && exec ./node_modules/.bin/tsx src/server.ts) &
api=$!
(cd apps/worker && exec ./node_modules/.bin/tsx src/index.ts) &
worker=$!

stop() { kill -TERM "$api" "$worker" 2>/dev/null; }
trap 'stop; wait; exit 0' TERM INT

while kill -0 "$api" 2>/dev/null && kill -0 "$worker" 2>/dev/null; do
  sleep 1
done
echo "start-api-and-worker: a process stopped; stopping the other" >&2
stop
wait
exit 1
