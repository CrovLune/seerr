import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const helperUrl = new URL('./compare-inventory.mjs', import.meta.url);
const helperPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'compare-inventory.mjs'
);
const requiredMigrations = [
  'SeerrMigration1759769291608',
  'AddTraktConnections1785456000000',
];

const loadCompareInventoryFiles = async () => {
  try {
    const module = await import(helperUrl);
    return module.compareInventoryFiles;
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      return undefined;
    }
    throw error;
  }
};

const sourceInventory = {
  integrity: 'ok',
  counts: {
    user: 2,
    media: 4,
    media_request: 3,
    issue: 1,
    user_settings: 2,
    season: 3,
    season_request: 2,
    issue_comment: 1,
    user_push_subscription: 1,
    watchlist: 2,
    blocklist: 1,
    override_rule: 1,
    discover_slider: 2,
    trakt_connection: 0,
  },
  users: [
    {
      id: 1,
      emailSha256: 'a'.repeat(64),
      username: 'Admin',
      userType: 1,
      plexId: 100,
      jellyfinUserId: null,
      permissions: 2,
      movieQuotaLimit: 5,
      movieQuotaDays: 30,
      tvQuotaLimit: 6,
      tvQuotaDays: 30,
    },
    {
      id: 2,
      emailSha256: 'b'.repeat(64),
      username: 'Family',
      userType: 3,
      plexId: null,
      jellyfinUserId: 'jellyfin-family',
      permissions: 64,
      movieQuotaLimit: null,
      movieQuotaDays: null,
      tvQuotaLimit: 2,
      tvQuotaDays: 7,
    },
  ],
  requests: {
    oldest: {
      id: 10,
      requestedById: 1,
      mediaId: 100,
      status: 2,
      createdAt: '2025-01-01 00:00:00',
    },
    newest: {
      id: 30,
      requestedById: 2,
      mediaId: 300,
      status: 3,
      createdAt: '2026-07-31 10:00:00',
    },
  },
  schema: {
    legacyUserTraktColumns: ['traktAccessToken'],
    migrationNames: ['LegacyMigration1'],
  },
};

const migratedInventory = {
  ...structuredClone(sourceInventory),
  schema: {
    legacyUserTraktColumns: [],
    migrationNames: ['LegacyMigration1', ...requiredMigrations],
  },
};

let fixtureRoot;
let fixtureNumber = 0;

before(async () => {
  fixtureRoot = await mkdtemp(path.join(tmpdir(), 'seerr-compare-inventory-'));
});

after(async () => {
  if (fixtureRoot) {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

const writeInventories = async (source, migrated) => {
  fixtureNumber += 1;
  const sourcePath = path.join(fixtureRoot, `source-${fixtureNumber}.json`);
  const migratedPath = path.join(fixtureRoot, `migrated-${fixtureNumber}.json`);
  await writeFile(sourcePath, JSON.stringify(source));
  await writeFile(migratedPath, JSON.stringify(migrated));
  return { sourcePath, migratedPath };
};

const compareFixture = async (mutateMigrated = () => {}) => {
  const compareInventoryFiles = await loadCompareInventoryFiles();
  assert.equal(
    typeof compareInventoryFiles,
    'function',
    'compareInventoryFiles must exist'
  );
  const source = structuredClone(sourceInventory);
  const migrated = structuredClone(migratedInventory);
  mutateMigrated(migrated);
  const { sourcePath, migratedPath } = await writeInventories(source, migrated);
  return compareInventoryFiles(sourcePath, migratedPath);
};

const compareBothFixtures = async (mutateBoth) => {
  const compareInventoryFiles = await loadCompareInventoryFiles();
  assert.equal(
    typeof compareInventoryFiles,
    'function',
    'compareInventoryFiles must exist'
  );
  const source = structuredClone(sourceInventory);
  const migrated = structuredClone(migratedInventory);
  mutateBoth(source, migrated);
  const { sourcePath, migratedPath } = await writeInventories(source, migrated);
  return compareInventoryFiles(sourcePath, migratedPath);
};

test('accepts a migration with exact legacy data and required clean Trakt schema', async () => {
  assert.equal(await compareFixture(), 'ok');
});

test('rejects a changed integration count', async () => {
  await assert.rejects(
    compareFixture((migrated) => {
      migrated.counts.issue += 1;
    }),
    /count mismatch for issue/
  );
});

test('rejects a legacy count omitted from both inventories', async () => {
  await assert.rejects(
    compareBothFixtures((source, migrated) => {
      delete source.counts.issue;
      delete migrated.counts.issue;
    }),
    /invalid count for issue/
  );
});

test('rejects changed safe user identity, permission, and quota fields', async () => {
  for (const [field, value] of [
    ['emailSha256', 'c'.repeat(64)],
    ['permissions', 128],
    ['movieQuotaLimit', 99],
    ['tvQuotaDays', 365],
  ]) {
    await assert.rejects(
      compareFixture((migrated) => {
        migrated.users[0][field] = value;
      }),
      new RegExp(`user mismatch.*${field}`)
    );
  }
});

test('rejects a safe user field omitted from both inventories', async () => {
  await assert.rejects(
    compareBothFixtures((source, migrated) => {
      delete source.users[0].permissions;
      delete migrated.users[0].permissions;
    }),
    /invalid user record.*permissions/
  );
});

test('rejects a changed request count', async () => {
  await assert.rejects(
    compareFixture((migrated) => {
      migrated.counts.media_request -= 1;
    }),
    /count mismatch for media_request/
  );
});

test('rejects every changed request boundary field', async () => {
  for (const [field, value] of [
    ['id', 31],
    ['requestedById', 99],
    ['mediaId', 999],
    ['status', 1],
    ['createdAt', '2026-07-31 11:00:00'],
  ]) {
    await assert.rejects(
      compareFixture((migrated) => {
        migrated.requests.newest[field] = value;
      }),
      new RegExp(`request newest mismatch.*${field}`)
    );
  }
});

test('reports malformed source and migrated JSON without echoing file content', async () => {
  const secretLikeValue = 'inventory-secret-like-value-that-must-not-leak';
  for (const malformedSide of ['source', 'migrated']) {
    const malformed = `{"secret":"${secretLikeValue}"`;
    const source =
      malformedSide === 'source' ? malformed : JSON.stringify(sourceInventory);
    const migrated =
      malformedSide === 'migrated'
        ? malformed
        : JSON.stringify(migratedInventory);
    fixtureNumber += 1;
    const sourcePath = path.join(
      fixtureRoot,
      `malformed-source-${fixtureNumber}.json`
    );
    const migratedPath = path.join(
      fixtureRoot,
      `malformed-migrated-${fixtureNumber}.json`
    );
    await writeFile(sourcePath, source);
    await writeFile(migratedPath, migrated);

    await assert.rejects(
      execFileAsync(process.execPath, [helperPath, sourcePath, migratedPath]),
      (error) => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, '');
        assert.equal(
          error.stderr,
          `${malformedSide} inventory JSON is invalid\n`
        );
        assert.equal(error.stdout.includes(secretLikeValue), false);
        assert.equal(error.stderr.includes(secretLikeValue), false);
        return true;
      }
    );
    assert.equal(await readFile(sourcePath, 'utf8'), source);
    assert.equal(await readFile(migratedPath, 'utf8'), migrated);
  }
});

test('rejects a residual legacy Trakt user column', async () => {
  await assert.rejects(
    compareFixture((migrated) => {
      migrated.schema.legacyUserTraktColumns = ['traktAccessToken'];
    }),
    /legacy Trakt columns remain/
  );
});

test('rejects a missing required migration record', async () => {
  await assert.rejects(
    compareFixture((migrated) => {
      migrated.schema.migrationNames = migrated.schema.migrationNames.filter(
        (name) => name !== requiredMigrations[0]
      );
    }),
    /required migration missing: SeerrMigration1759769291608/
  );
});

test('rejects a nonempty new Trakt connection table', async () => {
  await assert.rejects(
    compareFixture((migrated) => {
      migrated.counts.trakt_connection = 1;
    }),
    /trakt_connection must be empty/
  );
});

test('rejects a relative inventory path', async () => {
  const compareInventoryFiles = await loadCompareInventoryFiles();
  assert.equal(
    typeof compareInventoryFiles,
    'function',
    'compareInventoryFiles must exist'
  );
  await assert.rejects(
    compareInventoryFiles('source.json', '/tmp/migrated.json'),
    /absolute paths/
  );
});
