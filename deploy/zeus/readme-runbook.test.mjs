import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const readmePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'README.md'
);

const readRunbook = async () => readFile(readmePath, 'utf8');

const extractBashBlocks = (readme) =>
  [...readme.matchAll(/^```bash\s*\n([\s\S]*?)^```\s*$/gm)].map(
    (match) => match[1]
  );

test('every pasteable Bash block is syntactically valid and fail-fast', async () => {
  const readme = await readRunbook();
  const bashBlocks = extractBashBlocks(readme);

  assert.ok(bashBlocks.length > 0, 'README must contain Bash blocks');
  assert.match(readme, /persistent Bash shell/i);

  for (const [index, block] of bashBlocks.entries()) {
    assert.equal(
      block.trimStart().split('\n')[0],
      'set -Eeuo pipefail',
      `Bash block ${index + 1} must start with fail-fast semantics`
    );
    const syntax = spawnSync('bash', ['--noprofile', '--norc', '-n'], {
      input: block,
      encoding: 'utf8',
    });
    assert.equal(
      syntax.status,
      0,
      `Bash block ${index + 1} failed bash -n:\n${syntax.stderr}`
    );
  }
});

test('reconnect-safe final inventory derives and validates the immutable image', async () => {
  const readme = await readRunbook();
  const inventoryBlock = extractBashBlocks(readme).find((block) =>
    block.includes('final-inventory.json')
  );

  assert.ok(inventoryBlock, 'final inventory Bash block must exist');
  assert.match(
    inventoryBlock,
    /SEERR_IMAGE_REF="\$\(\s*awk -F= [\s\S]* "\$SEERR_ROOT\/\.env"\s*\)"/
  );
  const validationIndex = inventoryBlock.indexOf(
    "grep -E '^ghcr\\.io/crovlune/seerr@sha256:[0-9a-f]{64}$'"
  );
  const dockerRunIndex = inventoryBlock.indexOf('docker run --rm');
  assert.ok(validationIndex >= 0, 'immutable image validation must exist');
  assert.ok(
    validationIndex < dockerRunIndex,
    'immutable image must be validated before final inventory execution'
  );
});

test('rollback guards and verifies evidence before stopping Seerr', async () => {
  const readme = await readRunbook();
  const rollbackBlock = extractBashBlocks(readme).find(
    (block) =>
      block.includes('post-cutover-write.txt') &&
      block.includes('docker image load')
  );

  assert.ok(rollbackBlock, 'rollback Bash block must exist');
  const markerGuardIndex = rollbackBlock.indexOf(
    'test ! -e "$CUTOVER_BACKUP_ROOT/post-cutover-write.txt"'
  );
  const imageChecksumIndex = rollbackBlock.indexOf(
    'overseerr-image.tar.gz.sha256'
  );
  const imageLoadIndex = rollbackBlock.indexOf('docker image load');
  const imageIdCheckIndex = rollbackBlock.indexOf(
    'docker image inspect "$ROLLBACK_IMAGE_REF"'
  );
  const configChecksumIndex = rollbackBlock.indexOf(
    'overseerr-config-raw.tar.gz.sha256'
  );
  const seerrDownIndex = rollbackBlock.indexOf(
    'docker compose --env-file .env -f compose.yaml down --remove-orphans'
  );

  for (const [label, index] of [
    ['post-write marker guard', markerGuardIndex],
    ['image checksum', imageChecksumIndex],
    ['image load', imageLoadIndex],
    ['loaded image ID check', imageIdCheckIndex],
    ['config checksum', configChecksumIndex],
    ['Seerr shutdown', seerrDownIndex],
  ]) {
    assert.ok(index >= 0, `${label} must exist in rollback block`);
  }
  assert.ok(markerGuardIndex < imageChecksumIndex);
  assert.ok(imageChecksumIndex < imageLoadIndex);
  assert.ok(imageLoadIndex < imageIdCheckIndex);
  assert.ok(imageIdCheckIndex < seerrDownIndex);
  assert.ok(configChecksumIndex < seerrDownIndex);
});

test('old-container shutdown fails if Docker inspection fails', async () => {
  const readme = await readRunbook();
  const shutdownBlock = extractBashBlocks(readme).find(
    (block) =>
      block.includes('docker compose -f docker-compose.yml down') &&
      block.includes("name='^overseerr$'")
  );

  assert.ok(shutdownBlock, 'Overseerr shutdown Bash block must exist');
  assert.match(
    shutdownBlock,
    /OVERSEERR_IDS="\$\(docker ps -aq --filter name='\^overseerr\$'\)"\s*\ntest -z "\$OVERSEERR_IDS"/
  );
  assert.doesNotMatch(
    shutdownBlock,
    /test\s+-z\s+"\$\(docker ps/,
    'docker ps must run as its own fail-fast assignment'
  );
});
