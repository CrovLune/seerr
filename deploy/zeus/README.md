# Zeus Seerr deployment

This directory is the committed, secret-free deployment package for the Seerr
v3.4.1 Trakt migration. It prepares an isolated rehearsal and a same-domain
cutover; it does not contain live state.

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
destination, and retains a failed partial database as evidence. The sanitizer
accepts only the copied settings file, removes only its top-level `trakt`
property, and writes the temporary and final file with mode `0600`.

Render the merged Compose model before starting. The dummy digest below is for
local interpolation validation only; rehearsal and production use the real
digest from `.env`.

```bash
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
docker compose --env-file .env \
  -f compose.yaml -f compose.rehearsal.yaml down
```

## Final cutover

Perform cutover only after the rehearsal inventory and application checks are
accepted. Keep one persistent Zeus shell and a validated, explicit
`CUTOVER_BACKUP_ROOT`; never infer it from a glob or “latest.”

1. Record the old container, exact image ID/reference/digest, raw and resolved
   Compose, Watchtower state, source bundle, and optional environment file in a
   new mode-`0700` UTC backup root. Pin the rollback Compose to a retained local
   old-image tag with `pull_policy: never`, disable Watchtower, checksum the
   bundle, and write the exact root to the mode-`0600` active-cutover file.
2. Stop Overseerr. Copy its complete config, including SQLite WAL/SHM files,
   with `cp -a`; archive and checksum it; test a separate extraction with
   `diff -qr`. Save, checksum, and gzip-test the exact old image. Keep the old
   bind directory untouched.
3. Create `/home/crovlune/containers/seerr` once with `config/db` and `logs`
   owned by `1000:1000`. Copy the committed tools and mode-`0600` digest-pinned
   `.env`. Sanitize only a copied `settings.json`, create an online SQLite
   backup into the new config, inventory it, and prove the old config still
   equals the raw backup.
4. Bring the stopped Overseerr Compose project down with
   `down --remove-orphans`, without volumes. Confirm the old bind data, image,
   Compose source, and cutover backup still exist.
5. Render and inspect the final Seerr Compose file. Pull and start only the
   immutable digest. Wait for health, inspect migration logs, and confirm the
   running `.Config.Image` equals `SEERR_IMAGE_REF`.
6. Verify local health plus both production domains. The callback path without
   state must reach Seerr and return a validation response such as `400`; it
   must never redirect to the local hostname. Verify the public router from a
   non-LAN source.
7. Before configuring Trakt or creating a request, generate the final inventory
   and compare it with the cutover source inventory. Only then run login, Plex,
   existing-data, permission, request, and Trakt acceptance.
8. Retain the old image, config archive, checksums, rollback Compose, and source
   bundle until the owner explicitly authorizes retirement.

Production routing is intentionally exact:

- callback: public host plus exact callback path, priority `300`, `https`, no
  middleware;
- LAN public-host redirect: approved IPv4/IPv6 ranges, priority `200`,
  `redirect-to-local@file`;
- LAN local host: approved ranges, priority `200`, `ip-whitelist@file`;
- general public host: priority `100`, no middleware;
- service port `5055` on external network `traefik`; and
- Watchtower disabled.

There must be no interval in which Overseerr and Seerr both claim these
production host rules.

## Rollback

Before Seerr accepts a write, rollback uses only the validated backup root and
the pinned retained image:

```bash
cd /home/crovlune/containers/seerr
docker compose --env-file .env -f compose.yaml down --remove-orphans
gzip -dc "$CUTOVER_BACKUP_ROOT/overseerr-image.tar.gz" | docker image load
sha256sum -c "$CUTOVER_BACKUP_ROOT/overseerr-config-raw.tar.gz.sha256"
docker compose \
  -f "$CUTOVER_BACKUP_ROOT/docker-compose.rollback.yml" \
  up -d --pull never
test "$(docker inspect overseerr --format '{{.State.Running}}')" = true
docker exec overseerr \
  wget -q -O - http://127.0.0.1:5055/api/v1/status/appdata
```

Verify the loaded image ID, disabled Watchtower label, both domains, and a fresh
inventory against the cutover source evidence. Never overwrite an unexpected
config directory; restore an archive to a new explicit path and modify only a
copy of the rollback Compose file.

`docker compose down -v` is forbidden in rehearsal, cutover, and rollback. Do
not delete either application config or any rollback evidence. After Seerr
accepts any write, automatic database rollback is no longer available: the
databases have diverged, and restoring the old snapshot loses post-cutover
changes. Snapshot Seerr, account for those changes, explain the loss, and obtain
explicit owner approval before a later rollback.
