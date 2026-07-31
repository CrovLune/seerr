# Zeus Seerr deployment

This directory is the committed, secret-free deployment package for the Seerr
v3.4.1 Trakt migration. It prepares an isolated rehearsal and a same-domain
cutover; it does not contain live state.

Before copying any command block, start one persistent Bash shell with
`bash --noprofile --norc` and keep that shell open for the related rehearsal,
cutover, or rollback sequence so its validated context variables persist. Every
Bash block repeats `set -Eeuo pipefail`; a failed guard, command, pipeline, or
unset variable therefore aborts that block before its next action. Do not paste
these blocks into a shell that ignores those Bash semantics.

## Directory layout

Repository package:

```text
deploy/zeus/
├── .env.example
├── README.md
├── compare-inventory.mjs
├── compare-inventory.test.mjs
├── compose.rehearsal.yaml
├── compose.yaml
├── inventory-db.mjs
├── inventory-db.test.mjs
├── readme-runbook.test.mjs
├── sanitize-trakt-settings.mjs
├── sanitize-trakt-settings.test.mjs
├── sqlite-backup.mjs
└── sqlite-backup.test.mjs
```

Zeus paths:

```text
/home/crovlune/containers/overseerr/          # retained old deployment
/home/crovlune/containers/seerr-rehearsal/    # isolated rehearsal
/home/crovlune/containers/seerr/              # final Seerr deployment
/home/crovlune/backups/seerr-cutover/<UTC-ID> # immutable cutover evidence
```

`config`, `config/db`, and `logs` under either Seerr root must be owned by
UID/GID `1000:1000`. Both Compose definitions run Seerr as `1000:1000`; do not
change ownership or run the production container as root.

## Secrets and immutable image rule

`SEERR_IMAGE` must be the complete immutable reference
`ghcr.io/crovlune/seerr@sha256:<64 lowercase hex characters>`. Mutable tags,
including `latest` and `3.4.1-trakt.1`, are not deployment values. The committed
`.env.example` is deliberately empty and cannot render the Compose file. Create
the real mode-`0600` `.env` only on Zeus after Buildx resolves the digest.

Never commit `.env`, `settings.json`, databases, database sidecars, tokens,
credentials, or real source/migrated inventories. Do not print environment or
settings contents. Authentication for GHCR is performed separately and no
registry token belongs in this directory or an image layer.

Build and resolve the release image from the intended Git commit:

```bash
set -Eeuo pipefail
cd /Users/crovlune/Development/pet-projects/seerr
SEERR_COMMIT_SHA="$(git rev-parse HEAD)"
SEERR_SOURCE_EPOCH="$(git show -s --format=%ct HEAD)"
docker buildx build \
  --platform linux/amd64 \
  --build-arg COMMIT_TAG="$SEERR_COMMIT_SHA" \
  --build-arg SOURCE_DATE_EPOCH="$SEERR_SOURCE_EPOCH" \
  --tag ghcr.io/crovlune/seerr:3.4.1-trakt.1 \
  --push \
  .
docker buildx imagetools inspect ghcr.io/crovlune/seerr:3.4.1-trakt.1
```

Record the inspected digest, not the tag, in the Zeus `.env` and validate it:

```bash
set -Eeuo pipefail
chmod 0600 .env
SEERR_IMAGE_REF="$(awk -F= '$1 == "SEERR_IMAGE" { print $2 }' .env)"
printf '%s\n' "$SEERR_IMAGE_REF" |
  grep -E '^ghcr\.io/crovlune/seerr@sha256:[0-9a-f]{64}$'
```

## Rehearsal

Do not touch the original Overseerr config. Create the rehearsal root once; if
it already exists, stop and preserve it under an explicit timestamped name
before retrying.

```bash
set -Eeuo pipefail
REHEARSAL_ROOT=/home/crovlune/containers/seerr-rehearsal
OLD_CONFIG_ROOT=/home/crovlune/containers/overseerr/config
test ! -e "$REHEARSAL_ROOT"
install -d -m 0700 "$REHEARSAL_ROOT"
install -d -m 0700 -o 1000 -g 1000 \
  "$REHEARSAL_ROOT/config/db" "$REHEARSAL_ROOT/logs"
install -m 0644 deploy/zeus/compose.yaml \
  "$REHEARSAL_ROOT/compose.yaml"
install -m 0644 deploy/zeus/compose.rehearsal.yaml \
  "$REHEARSAL_ROOT/compose.rehearsal.yaml"
install -m 0644 deploy/zeus/sqlite-backup.mjs \
  deploy/zeus/inventory-db.mjs \
  deploy/zeus/compare-inventory.mjs \
  deploy/zeus/sanitize-trakt-settings.mjs \
  "$REHEARSAL_ROOT/"
```

Create `$REHEARSAL_ROOT/.env` with only the validated digest-pinned
`SEERR_IMAGE`, then `chmod 0600` it. Record and validate the exact running old
image ID before using it as the migration-tool runtime:

```bash
set -Eeuo pipefail
OLD_IMAGE_ID="$(docker inspect overseerr --format '{{.Image}}')"
printf '%s\n' "$OLD_IMAGE_ID" | grep -E '^sha256:[0-9a-f]{64}$'
rsync -a --exclude '/db/' --exclude '/logs/' --exclude '/cache/' \
  "$OLD_CONFIG_ROOT/" "$REHEARSAL_ROOT/config/"

docker run --rm --user 1000:1000 --entrypoint node \
  -v "$REHEARSAL_ROOT:/work" "$OLD_IMAGE_ID" \
  /work/sanitize-trakt-settings.mjs /work/config/settings.json

docker run --rm --user 1000:1000 --entrypoint node \
  -v "$OLD_CONFIG_ROOT:/source:ro" \
  -v "$REHEARSAL_ROOT/config/db:/destination" \
  -v "$REHEARSAL_ROOT/sqlite-backup.mjs:/app/sqlite-backup.mjs:ro" \
  "$OLD_IMAGE_ID" /app/sqlite-backup.mjs \
  /source/db/db.sqlite3 /destination/db.sqlite3

docker run --rm --user 1000:1000 --entrypoint node \
  -v "$REHEARSAL_ROOT/config/db:/data:ro" \
  -v "$REHEARSAL_ROOT/inventory-db.mjs:/app/inventory-db.mjs:ro" \
  "$OLD_IMAGE_ID" /app/inventory-db.mjs /data/db.sqlite3 \
  > "$REHEARSAL_ROOT/source-inventory.json"
```

The backup helper accepts exactly two absolute paths, never overwrites a
destination, and retains a failed partial database as evidence. On success it
prints whether partial cleanup completed; if cleanup fails after atomic
publication, it reports the exact retained hard-link path while keeping the
valid destination and a successful exit. The sanitizer accepts only the copied
settings file, removes only its top-level `trakt` property, and writes the
temporary and final file with mode `0600`.

Render the merged Compose model before starting. The dummy digest below is for
local interpolation validation only; rehearsal and production use the real
digest from `.env`.

```bash
set -Eeuo pipefail
SEERR_IMAGE=ghcr.io/crovlune/seerr@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  docker compose -f deploy/zeus/compose.yaml \
  -f deploy/zeus/compose.rehearsal.yaml config >/dev/null

cd "$REHEARSAL_ROOT"
docker compose --env-file .env \
  -f compose.yaml -f compose.rehearsal.yaml config --format json \
  > rendered-rehearsal.json
docker compose --env-file .env \
  -f compose.yaml -f compose.rehearsal.yaml pull
docker compose --env-file .env \
  -f compose.yaml -f compose.rehearsal.yaml up -d
test "$(docker inspect seerr-rehearsal --format '{{.State.Health.Status}}')" = healthy
```

The override must render `container_name: seerr-rehearsal`, loopback-only port
`127.0.0.1:15055`, restart policy `no`, and `traefik.enable=false`. It must not
claim production routing. Before any disposable rehearsal write, generate the
migrated inventory and compare it:

```bash
set -Eeuo pipefail
cd "$REHEARSAL_ROOT"
SEERR_IMAGE_REF="$(awk -F= '$1 == "SEERR_IMAGE" { print $2 }' .env)"
docker run --rm --user 1000:1000 --entrypoint node \
  -v "$PWD/config/db:/data:ro" \
  -v "$PWD/inventory-db.mjs:/app/inventory-db.mjs:ro" \
  "$SEERR_IMAGE_REF" /app/inventory-db.mjs /data/db.sqlite3 \
  > migrated-inventory.json
docker run --rm --entrypoint node \
  -v "$PWD:/work:ro" "$SEERR_IMAGE_REF" \
  /work/compare-inventory.mjs \
  /work/source-inventory.json /work/migrated-inventory.json
```

Comparison requires `integrity: ok`, every listed legacy count, all safe user
identity/permission/quota fields, and both complete request boundary records to
match. It also requires migration records `SeerrMigration1759769291608` and
`AddTraktConnections1785456000000`, no legacy `user.trakt*` columns, and zero
rows in `trakt_connection`.

Stop rehearsal while preserving its config and evidence:

```bash
set -Eeuo pipefail
docker compose --env-file .env \
  -f compose.yaml -f compose.rehearsal.yaml down
```

## Final cutover

Run this only after the rehearsal is accepted. Use one persistent Zeus shell.
Do not infer state from a glob, directory order, or a mutable tag.

### 1. Create and record the immutable backup context

Prove the live service still uses the expected Compose and bind paths, then
create one new UTC backup root:

```bash
set -Eeuo pipefail
test "$(docker inspect overseerr --format '{{.State.Running}}')" = true
test "$(docker inspect overseerr --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}')" = \
  /home/crovlune/containers/overseerr/docker-compose.yml
test "$(docker inspect overseerr --format '{{range .Mounts}}{{if eq .Destination "/app/config"}}{{.Source}}{{end}}{{end}}')" = \
  /home/crovlune/containers/overseerr/config

CUTOVER_ID="$(date -u +%Y%m%dT%H%M%SZ)"
CUTOVER_BACKUP_ROOT="/home/crovlune/backups/seerr-cutover/$CUTOVER_ID"
ACTIVE_CUTOVER_FILE=/home/crovlune/backups/seerr-cutover/active-cutover.txt
OLD_COMPOSE_FILE=/home/crovlune/containers/overseerr/docker-compose.yml
OLD_CONFIG_DIR=/home/crovlune/containers/overseerr/config
SEERR_ROOT=/home/crovlune/containers/seerr
umask 077

printf '%s\n' "$CUTOVER_BACKUP_ROOT" |
  grep -E '^/home/crovlune/backups/seerr-cutover/[0-9]{8}T[0-9]{6}Z$'
test ! -e "$ACTIVE_CUTOVER_FILE"
test ! -e "$CUTOVER_BACKUP_ROOT"
AVAILABLE_KB="$(df -Pk /home/crovlune/backups | awk 'NR == 2 { print $4 }')"
test "$AVAILABLE_KB" -gt 10485760

OLD_IMAGE_ID="$(docker inspect overseerr --format '{{.Image}}')"
OLD_IMAGE_REF="$(docker inspect overseerr --format '{{.Config.Image}}')"
OLD_IMAGE_DIGEST="$(
  docker image inspect "$OLD_IMAGE_ID" --format '{{index .RepoDigests 0}}'
)"
OLD_WATCHTOWER="$(
  docker inspect overseerr --format \
    '{{index .Config.Labels "com.centurylinklabs.watchtower.enable"}}'
)"
ROLLBACK_IMAGE_REF="ghcr.io/crovlune/overseerr:rollback-$CUTOVER_ID"
printf '%s\n' "$OLD_IMAGE_ID" | grep -E '^sha256:[0-9a-f]{64}$'
test -n "$OLD_IMAGE_REF"
test -n "$OLD_IMAGE_DIGEST"
test -n "$OLD_WATCHTOWER"

docker image tag "$OLD_IMAGE_ID" "$ROLLBACK_IMAGE_REF"
install -d -m 0700 "$CUTOVER_BACKUP_ROOT"
test "$(stat -c '%a' "$CUTOVER_BACKUP_ROOT")" = 700
docker inspect overseerr \
  > "$CUTOVER_BACKUP_ROOT/overseerr-container-inspect.json"
docker image inspect "$OLD_IMAGE_ID" \
  > "$CUTOVER_BACKUP_ROOT/overseerr-image-inspect.json"
docker compose ls -a > "$CUTOVER_BACKUP_ROOT/compose-ls.txt"
install -m 0600 \
  /home/crovlune/backups/source-archives/overseerr-trakt-2026-07-31.bundle \
  /home/crovlune/backups/source-archives/overseerr-trakt-2026-07-31.bundle.sha256 \
  "$CUTOVER_BACKUP_ROOT/"
(cd "$CUTOVER_BACKUP_ROOT" && \
  sha256sum -c overseerr-trakt-2026-07-31.bundle.sha256)
install -m 0600 \
  "$OLD_COMPOSE_FILE" "$CUTOVER_BACKUP_ROOT/docker-compose.yml"
if test -f /home/crovlune/containers/overseerr/.env; then
  install -m 0600 \
    /home/crovlune/containers/overseerr/.env \
    "$CUTOVER_BACKUP_ROOT/overseerr.env"
fi

cd /home/crovlune/containers/overseerr
docker compose -f docker-compose.yml config \
  > "$CUTOVER_BACKUP_ROOT/docker-compose.rollback.yml"
sed -i \
  "s#^    image: .*#    image: $ROLLBACK_IMAGE_REF#" \
  "$CUTOVER_BACKUP_ROOT/docker-compose.rollback.yml"
sed -i \
  '/^    image:/a\    pull_policy: never' \
  "$CUTOVER_BACKUP_ROOT/docker-compose.rollback.yml"
sed -i \
  's/com.centurylinklabs.watchtower.enable: "true"/com.centurylinklabs.watchtower.enable: "false"/' \
  "$CUTOVER_BACKUP_ROOT/docker-compose.rollback.yml"
docker compose -f "$CUTOVER_BACKUP_ROOT/docker-compose.rollback.yml" config \
  > /dev/null
grep -F "image: $ROLLBACK_IMAGE_REF" \
  "$CUTOVER_BACKUP_ROOT/docker-compose.rollback.yml"
grep -F 'pull_policy: never' \
  "$CUTOVER_BACKUP_ROOT/docker-compose.rollback.yml"
grep -F 'com.centurylinklabs.watchtower.enable: "false"' \
  "$CUTOVER_BACKUP_ROOT/docker-compose.rollback.yml"

printf 'old_image_id=%s\nold_image_ref=%s\nold_image_digest=%s\nold_watchtower=%s\nrollback_image_ref=%s\nold_config_dir=%s\nold_compose_file=%s\n' \
  "$OLD_IMAGE_ID" "$OLD_IMAGE_REF" "$OLD_IMAGE_DIGEST" "$OLD_WATCHTOWER" \
  "$ROLLBACK_IMAGE_REF" "$OLD_CONFIG_DIR" "$OLD_COMPOSE_FILE" \
  > "$CUTOVER_BACKUP_ROOT/rollback.txt"
chmod 0600 "$CUTOVER_BACKUP_ROOT/rollback.txt"
printf '%s\n' "$CUTOVER_BACKUP_ROOT" > "$ACTIVE_CUTOVER_FILE"
chmod 0600 "$ACTIVE_CUTOVER_FILE"
test "$(stat -c '%a' "$CUTOVER_BACKUP_ROOT/rollback.txt")" = 600
test "$(stat -c '%a' "$ACTIVE_CUTOVER_FILE")" = 600
test "$(cat "$ACTIVE_CUTOVER_FILE")" = "$CUTOVER_BACKUP_ROOT"
```

After any reconnect, restore only this explicitly recorded context:

```bash
set -Eeuo pipefail
CUTOVER_BACKUP_ROOT="$(
  cat /home/crovlune/backups/seerr-cutover/active-cutover.txt
)"
printf '%s\n' "$CUTOVER_BACKUP_ROOT" |
  grep -E '^/home/crovlune/backups/seerr-cutover/[0-9]{8}T[0-9]{6}Z$'
test -d "$CUTOVER_BACKUP_ROOT"
test -f "$CUTOVER_BACKUP_ROOT/rollback.txt"
OLD_CONFIG_DIR="$(
  awk -F= '$1 == "old_config_dir" { print $2 }' \
    "$CUTOVER_BACKUP_ROOT/rollback.txt"
)"
OLD_IMAGE_ID="$(
  awk -F= '$1 == "old_image_id" { print $2 }' \
    "$CUTOVER_BACKUP_ROOT/rollback.txt"
)"
OLD_COMPOSE_FILE="$(
  awk -F= '$1 == "old_compose_file" { print $2 }' \
    "$CUTOVER_BACKUP_ROOT/rollback.txt"
)"
ROLLBACK_IMAGE_REF="$(
  awk -F= '$1 == "rollback_image_ref" { print $2 }' \
    "$CUTOVER_BACKUP_ROOT/rollback.txt"
)"
test "$OLD_CONFIG_DIR" = /home/crovlune/containers/overseerr/config
test "$OLD_COMPOSE_FILE" = \
  /home/crovlune/containers/overseerr/docker-compose.yml
printf '%s\n' "$OLD_IMAGE_ID" | grep -E '^sha256:[0-9a-f]{64}$'
test -n "$ROLLBACK_IMAGE_REF"
SEERR_ROOT=/home/crovlune/containers/seerr
```

### 2. Stop Overseerr and prove the raw config and image backups

Stopping precedes `cp -a`, so the raw archive includes a coherent complete
config and any SQLite WAL/SHM files that exist.

```bash
set -Eeuo pipefail
cd /home/crovlune/containers/overseerr
docker compose -f docker-compose.yml stop overseerr
test "$(docker inspect overseerr --format '{{.State.Status}}')" = exited

test ! -e "$CUTOVER_BACKUP_ROOT/overseerr-config-raw"
cp -a "$OLD_CONFIG_DIR" "$CUTOVER_BACKUP_ROOT/overseerr-config-raw"
tar -C "$CUTOVER_BACKUP_ROOT" \
  -czf "$CUTOVER_BACKUP_ROOT/overseerr-config-raw.tar.gz" \
  overseerr-config-raw
sha256sum "$CUTOVER_BACKUP_ROOT/overseerr-config-raw.tar.gz" \
  > "$CUTOVER_BACKUP_ROOT/overseerr-config-raw.tar.gz.sha256"
sha256sum -c \
  "$CUTOVER_BACKUP_ROOT/overseerr-config-raw.tar.gz.sha256"
test "$(docker image inspect "$ROLLBACK_IMAGE_REF" --format '{{.Id}}')" = \
  "$OLD_IMAGE_ID"
docker image save "$ROLLBACK_IMAGE_REF" |
  gzip > "$CUTOVER_BACKUP_ROOT/overseerr-image.tar.gz"
sha256sum "$CUTOVER_BACKUP_ROOT/overseerr-image.tar.gz" \
  > "$CUTOVER_BACKUP_ROOT/overseerr-image.tar.gz.sha256"
sha256sum -c "$CUTOVER_BACKUP_ROOT/overseerr-image.tar.gz.sha256"
gzip -t "$CUTOVER_BACKUP_ROOT/overseerr-image.tar.gz"
tar -tzf "$CUTOVER_BACKUP_ROOT/overseerr-config-raw.tar.gz" \
  > "$CUTOVER_BACKUP_ROOT/overseerr-config-raw.manifest.txt"

test ! -e "$CUTOVER_BACKUP_ROOT/config-restore-test"
install -d -m 0700 "$CUTOVER_BACKUP_ROOT/config-restore-test"
tar -xzf "$CUTOVER_BACKUP_ROOT/overseerr-config-raw.tar.gz" \
  -C "$CUTOVER_BACKUP_ROOT/config-restore-test"
diff -qr \
  "$CUTOVER_BACKUP_ROOT/overseerr-config-raw" \
  "$CUTOVER_BACKUP_ROOT/config-restore-test/overseerr-config-raw"

test ! -e "$CUTOVER_BACKUP_ROOT/source-restore-test"
git clone --no-checkout \
  --branch archive/overseerr-trakt-2026-07-31 \
  "$CUTOVER_BACKUP_ROOT/overseerr-trakt-2026-07-31.bundle" \
  "$CUTOVER_BACKUP_ROOT/source-restore-test"
git -C "$CUTOVER_BACKUP_ROOT/source-restore-test" show-ref --verify \
  refs/remotes/origin/archive/overseerr-trakt-2026-07-31
```

Do not restart Overseerr unless the rollback section is being executed.

### 3. Create and verify the final clean migration copy

The final root is new. Sanitization and migration operate only on copies under
the final or cutover backup roots.

```bash
set -Eeuo pipefail
SEERR_ROOT=/home/crovlune/containers/seerr
test ! -e "$SEERR_ROOT"
install -d -m 0700 "$SEERR_ROOT"
install -d -m 0700 -o 1000 -g 1000 \
  "$SEERR_ROOT/config/db" "$SEERR_ROOT/logs"
test "$(stat -c '%u:%g' "$SEERR_ROOT/config/db")" = 1000:1000
test "$(stat -c '%u:%g' "$SEERR_ROOT/logs")" = 1000:1000
install -m 0644 \
  /home/crovlune/containers/seerr-rehearsal/compose.yaml \
  "$SEERR_ROOT/compose.yaml"
install -m 0644 \
  /home/crovlune/containers/seerr-rehearsal/inventory-db.mjs \
  /home/crovlune/containers/seerr-rehearsal/compare-inventory.mjs \
  /home/crovlune/containers/seerr-rehearsal/sqlite-backup.mjs \
  /home/crovlune/containers/seerr-rehearsal/sanitize-trakt-settings.mjs \
  "$SEERR_ROOT/"
install -m 0600 \
  /home/crovlune/containers/seerr-rehearsal/.env \
  "$SEERR_ROOT/.env"
test "$(stat -c '%a' "$SEERR_ROOT/.env")" = 600

SEERR_IMAGE_REF="$(awk -F= '$1 == "SEERR_IMAGE" { print $2 }' "$SEERR_ROOT/.env")"
printf '%s\n' "$SEERR_IMAGE_REF" |
  grep -E '^ghcr\.io/crovlune/seerr@sha256:[0-9a-f]{64}$'

rsync -a \
  --exclude '/db/' \
  --exclude '/logs/' \
  --exclude '/cache/' \
  "$CUTOVER_BACKUP_ROOT/overseerr-config-raw/" "$SEERR_ROOT/config/"
test ! -e "$CUTOVER_BACKUP_ROOT/overseerr-config-working"
cp -a \
  "$CUTOVER_BACKUP_ROOT/overseerr-config-raw" \
  "$CUTOVER_BACKUP_ROOT/overseerr-config-working"

docker run --rm \
  --user 1000:1000 \
  --entrypoint node \
  -v "$SEERR_ROOT:/work" \
  "$OLD_IMAGE_ID" \
  /work/sanitize-trakt-settings.mjs /work/config/settings.json
docker run --rm \
  --user 1000:1000 \
  --entrypoint node \
  -v "$SEERR_ROOT:/work:ro" \
  "$OLD_IMAGE_ID" \
  -e 'const fs=require("node:fs");const s=JSON.parse(fs.readFileSync("/work/config/settings.json","utf8"));if(Object.hasOwn(s,"trakt")||Object.hasOwn(s.main??{},"mediaServerType"))process.exit(1);console.log("legacy migration precondition: ready")'

docker run --rm \
  --user 1000:1000 \
  --entrypoint node \
  -v "$CUTOVER_BACKUP_ROOT/overseerr-config-working:/source" \
  -v "$SEERR_ROOT/config/db:/destination" \
  -v "$SEERR_ROOT/sqlite-backup.mjs:/app/sqlite-backup.mjs:ro" \
  "$OLD_IMAGE_ID" \
  /app/sqlite-backup.mjs \
  /source/db/db.sqlite3 \
  /destination/db.sqlite3

docker run --rm \
  --user 1000:1000 \
  --entrypoint node \
  -v "$SEERR_ROOT/config/db:/data:ro" \
  -v "$SEERR_ROOT/inventory-db.mjs:/app/inventory-db.mjs:ro" \
  "$OLD_IMAGE_ID" \
  /app/inventory-db.mjs /data/db.sqlite3 \
  > "$CUTOVER_BACKUP_ROOT/cutover-source-inventory.json"
jq -e '.integrity == "ok"' \
  "$CUTOVER_BACKUP_ROOT/cutover-source-inventory.json"
diff -qr \
  "$OLD_CONFIG_DIR" \
  "$CUTOVER_BACKUP_ROOT/overseerr-config-raw"
```

Only after every backup/copy check succeeds, remove the stopped old Compose
project without deleting volumes:

```bash
set -Eeuo pipefail
cd /home/crovlune/containers/overseerr
docker compose -f docker-compose.yml down --remove-orphans
OVERSEERR_IDS="$(docker ps -aq --filter name='^overseerr$')"
test -z "$OVERSEERR_IDS"
test -d "$OLD_CONFIG_DIR"
test -f "$OLD_COMPOSE_FILE"
test -d "$CUTOVER_BACKUP_ROOT/overseerr-config-raw"
docker image inspect "$OLD_IMAGE_ID" > /dev/null
```

### 4. Validate, start, and identify the immutable Seerr deployment

```bash
set -Eeuo pipefail
cd /home/crovlune/containers/seerr
SEERR_IMAGE_REF="$(awk -F= '$1 == "SEERR_IMAGE" { print $2 }' .env)"
printf '%s\n' "$SEERR_IMAGE_REF" |
  grep -E '^ghcr\.io/crovlune/seerr@sha256:[0-9a-f]{64}$'
docker compose --env-file .env -f compose.yaml config --format json \
  > rendered-compose.json
jq -e --arg image "$SEERR_IMAGE_REF" '
  .services.seerr.image == $image and
  .services.seerr.init == true and
  .services.seerr.user == "1000:1000" and
  any(.services.seerr.volumes[]; .target == "/app/config") and
  any(.services.seerr.volumes[]; .target == "/app/config/logs") and
  .services.seerr.labels["traefik.http.routers.seerr-trakt-callback.priority"] == "300" and
  .services.seerr.labels["traefik.http.routers.seerr-trakt-callback.entrypoints"] == "https" and
  (.services.seerr.labels | has("traefik.http.routers.seerr-trakt-callback.middlewares") | not) and
  .services.seerr.labels["traefik.http.routers.seerr-lan-redirect.priority"] == "200" and
  .services.seerr.labels["traefik.http.routers.seerr-lan-redirect.middlewares"] == "redirect-to-local@file" and
  .services.seerr.labels["traefik.http.routers.seerr-local.priority"] == "200" and
  .services.seerr.labels["traefik.http.routers.seerr-local.middlewares"] == "ip-whitelist@file" and
  .services.seerr.labels["traefik.http.routers.seerr-public.priority"] == "100" and
  (.services.seerr.labels | has("traefik.http.routers.seerr-public.middlewares") | not) and
  .services.seerr.labels["traefik.http.services.seerr.loadbalancer.server.port"] == "5055" and
  .services.seerr.labels["com.centurylinklabs.watchtower.enable"] == "false"
' rendered-compose.json
docker compose --env-file .env -f compose.yaml pull
docker compose --env-file .env -f compose.yaml up -d
for attempt in $(seq 1 10); do
  if test "$(docker inspect seerr --format '{{.State.Health.Status}}')" = healthy; then
    break
  fi
  sleep 5
done
test "$(docker inspect seerr --format '{{.State.Health.Status}}')" = healthy
docker compose --env-file .env -f compose.yaml ps
docker compose --env-file .env -f compose.yaml logs --no-color --tail=300 seerr
test "$(docker inspect seerr --format '{{.Config.Image}}')" = "$SEERR_IMAGE_REF"
```

The callback router has no middleware and outranks the LAN redirect, which in
turn outranks the general public router. There is no interval where both apps
claim the production hosts.

### 5. Verify routing before accepting writes

Run the container check on Zeus and the domain checks from the Mac/LAN:

```bash
set -Eeuo pipefail
docker exec seerr \
  wget -q -O - http://127.0.0.1:5055/api/v1/status/appdata
curl -sk -o /dev/null -w '%{http_code} %{redirect_url}\n' \
  https://overseerr.pixeltrophies.com/api/v1/status/appdata
curl -sk -o /dev/null -w '%{http_code} %{redirect_url}\n' \
  https://overseerr.local.pixeltrophies.com/api/v1/status/appdata
curl -sk -o /dev/null -w '%{http_code} %{redirect_url}\n' \
  'https://overseerr.pixeltrophies.com/api/v1/auth/trakt/callback'
```

The callback without state must return a Seerr validation response such as
`400`, never a redirect to the private hostname. From a non-LAN source, the
public host must return Seerr `200`; that lower-priority route cannot be proven
from a LAN source address.

### 6. Compare final migrated data before configuration or requests

```bash
set -Eeuo pipefail
SEERR_ROOT=/home/crovlune/containers/seerr
SEERR_IMAGE_REF="$(
  awk -F= '$1 == "SEERR_IMAGE" { print $2 }' "$SEERR_ROOT/.env"
)"
printf '%s\n' "$SEERR_IMAGE_REF" |
  grep -E '^ghcr\.io/crovlune/seerr@sha256:[0-9a-f]{64}$'
cd "$SEERR_ROOT"
docker run --rm \
  --user 1000:1000 \
  --entrypoint node \
  -v "$PWD/config/db:/data:ro" \
  -v "$PWD/inventory-db.mjs:/app/inventory-db.mjs:ro" \
  "$SEERR_IMAGE_REF" \
  /app/inventory-db.mjs /data/db.sqlite3 \
  > "$CUTOVER_BACKUP_ROOT/final-inventory.json"
docker run --rm \
  --entrypoint node \
  -v "$PWD:/work:ro" \
  -v "$CUTOVER_BACKUP_ROOT:/evidence:ro" \
  "$SEERR_IMAGE_REF" \
  /work/compare-inventory.mjs \
  /evidence/cutover-source-inventory.json \
  /evidence/final-inventory.json
```

### 7. Acceptance and final retained-evidence checks

Before the first Seerr write, verify in the production browser:

1. administrator login, Plex, existing media/requests/issues/notifications, and
   administrator/user permissions;
2. exact Trakt callback registration
   `https://overseerr.pixeltrophies.com/api/v1/auth/trakt/callback`;
3. one admin household authorization and one family self-service authorization,
   each with `prompt=login`;
4. duplicate Trakt identity returns `409` without reassignment;
5. reconnect creates no duplicate, household/self watch visibility is correct,
   and unlink/reconnect leaves one row; and
6. only after all read-only checks, create and update one disposable request.

After that first write, record that snapshot rollback will lose new changes:

```bash
set -Eeuo pipefail
printf 'automatic_database_rollback=false\nfirst_seerr_write_recorded_at=%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  > "$CUTOVER_BACKUP_ROOT/post-cutover-write.txt"
chmod 0600 "$CUTOVER_BACKUP_ROOT/post-cutover-write.txt"

docker ps -a --filter name=overseerr
docker ps --filter name=seerr
sha256sum -c "$CUTOVER_BACKUP_ROOT/overseerr-config-raw.tar.gz.sha256"
sha256sum -c "$CUTOVER_BACKUP_ROOT/overseerr-image.tar.gz.sha256"
docker inspect seerr --format \
  '{{index .Config.Labels "com.centurylinklabs.watchtower.enable"}} {{.Config.Image}}'
```

Retain the old image, config archive, checksums, rollback Compose, and source
bundle until the owner explicitly authorizes retirement.

## Rollback

Before any Seerr write, require the write marker to be absent. Restore and
validate the explicit context, verify both archive checksums before use, then
load the exact old image:

```bash
set -Eeuo pipefail
CUTOVER_BACKUP_ROOT="$(
  cat /home/crovlune/backups/seerr-cutover/active-cutover.txt
)"
printf '%s\n' "$CUTOVER_BACKUP_ROOT" |
  grep -E '^/home/crovlune/backups/seerr-cutover/[0-9]{8}T[0-9]{6}Z$'
test -d "$CUTOVER_BACKUP_ROOT"
test -f "$CUTOVER_BACKUP_ROOT/rollback.txt"
test ! -e "$CUTOVER_BACKUP_ROOT/post-cutover-write.txt"
OLD_IMAGE_ID="$(
  awk -F= '$1 == "old_image_id" { print $2 }' \
    "$CUTOVER_BACKUP_ROOT/rollback.txt"
)"
ROLLBACK_IMAGE_REF="$(
  awk -F= '$1 == "rollback_image_ref" { print $2 }' \
    "$CUTOVER_BACKUP_ROOT/rollback.txt"
)"
printf '%s\n' "$OLD_IMAGE_ID" | grep -E '^sha256:[0-9a-f]{64}$'
test -n "$ROLLBACK_IMAGE_REF"

sha256sum -c "$CUTOVER_BACKUP_ROOT/overseerr-image.tar.gz.sha256"
gzip -t "$CUTOVER_BACKUP_ROOT/overseerr-image.tar.gz"
sha256sum -c "$CUTOVER_BACKUP_ROOT/overseerr-config-raw.tar.gz.sha256"
gzip -dc "$CUTOVER_BACKUP_ROOT/overseerr-image.tar.gz" | docker image load
test "$(docker image inspect "$ROLLBACK_IMAGE_REF" --format '{{.Id}}')" = \
  "$OLD_IMAGE_ID"
test -d /home/crovlune/containers/overseerr/config

cd /home/crovlune/containers/seerr
docker compose --env-file .env -f compose.yaml down --remove-orphans
docker compose \
  -f "$CUTOVER_BACKUP_ROOT/docker-compose.rollback.yml" \
  up -d --pull never
for attempt in $(seq 1 12); do
  if test "$(docker inspect overseerr --format '{{.State.Running}}')" = true; then
    break
  fi
  sleep 4
done
test "$(docker inspect overseerr --format '{{.State.Running}}')" = true
test "$(docker inspect overseerr --format '{{.Image}}')" = "$OLD_IMAGE_ID"
test "$(docker inspect overseerr --format '{{.Config.Image}}')" = \
  "$ROLLBACK_IMAGE_REF"
test "$(docker inspect overseerr --format '{{index .Config.Labels "com.centurylinklabs.watchtower.enable"}}')" = false
docker exec overseerr \
  wget -q -O - http://127.0.0.1:5055/api/v1/status/appdata
```

Generate a fresh safe inventory from the unchanged old database, compare it
with the cutover source evidence, and verify both domains:

```bash
set -Eeuo pipefail
SEERR_ROOT=/home/crovlune/containers/seerr
docker run --rm \
  --user 1000:1000 \
  --entrypoint node \
  -v /home/crovlune/containers/overseerr/config/db:/data:ro \
  -v "$SEERR_ROOT/inventory-db.mjs:/app/inventory-db.mjs:ro" \
  "$OLD_IMAGE_ID" \
  /app/inventory-db.mjs /data/db.sqlite3 \
  > "$CUTOVER_BACKUP_ROOT/rollback-inventory.json"
diff -u \
  "$CUTOVER_BACKUP_ROOT/cutover-source-inventory.json" \
  "$CUTOVER_BACKUP_ROOT/rollback-inventory.json"
curl -sk -o /dev/null -w '%{http_code} %{redirect_url}\n' \
  https://overseerr.pixeltrophies.com/api/v1/status/appdata
curl -sk -o /dev/null -w '%{http_code} %{redirect_url}\n' \
  https://overseerr.local.pixeltrophies.com/api/v1/status/appdata
```

If `/home/crovlune/containers/overseerr/config` is unexpectedly absent, stop.
Restore the verified archive into a new explicit directory under the validated
backup root and update only a copied rollback Compose file; never overwrite or
populate an unexpected path.

`docker compose down -v` is forbidden in rehearsal, cutover, and rollback. Do
not delete either application config or any rollback evidence. After Seerr
accepts any write, automatic database rollback is no longer available: the
databases have diverged, and restoring the old snapshot loses post-cutover
changes. Snapshot Seerr, account for those changes, explain the loss, and obtain
explicit owner approval before a later rollback.
