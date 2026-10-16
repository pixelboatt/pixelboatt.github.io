#!/usr/bin/env bash
# Build the site and sync dist/ to the nginx host serving parintorn.com.
#
#   npm run deploy:vm               # build, back up the live folder, sync, check
#   npm run deploy:vm -- --dry-run  # build and show what rsync would change
#
# The previous release is kept in html.prev on the host. To roll back:
#   ssh me-dgo 'rsync -a --delete /var/www/parintorn.com/html.prev/ /var/www/parintorn.com/html/'
set -euo pipefail

HOST="${DEPLOY_HOST:-me-dgo}"
DIR=/var/www/parintorn.com/html
URL=https://parintorn.com

dry_run=false
[[ "${1:-}" == "--dry-run" ]] && dry_run=true

cd "$(dirname "$0")/.."

if [[ -n "$(git status --porcelain)" ]]; then
  echo "warning: working tree has uncommitted changes; they will be deployed" >&2
fi

npm run build

if $dry_run; then
  rsync -avzn --delete dist/ "$HOST:$DIR/"
  exit 0
fi

ssh "$HOST" "rm -rf $DIR.prev && cp -a $DIR $DIR.prev"
rsync -avz --delete dist/ "$HOST:$DIR/"

status=$(curl -s -o /dev/null -w '%{http_code}' "$URL")
echo "$URL -> $status"
[[ "$status" == 200 ]]
