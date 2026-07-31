import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import sqlite3 from 'sqlite3';

const helperUrl = new URL('./inventory-db.mjs', import.meta.url);
const hashEmail = (email) =>
  createHash('sha256').update(email.trim().toLowerCase()).digest('hex');

const loadCreateInventory = async () => {
  try {
    const module = await import(helperUrl);
    return module.createInventory;
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      return undefined;
    }
    throw error;
  }
};

const openDatabase = (databasePath) =>
  new Promise((resolve, reject) => {
    const database = new sqlite3.Database(databasePath, (error) =>
      error ? reject(error) : resolve(database)
    );
  });

const exec = (database, sql) =>
  new Promise((resolve, reject) => {
    database.exec(sql, (error) => (error ? reject(error) : resolve()));
  });

const close = (database) =>
  new Promise((resolve, reject) => {
    database.close((error) => (error ? reject(error) : resolve()));
  });

const fixtureSecrets = [
  'Admin@Example.COM ',
  'family@example.com',
  'fixture-password-secret',
  'fixture-plex-token',
  'fixture-jellyfin-token',
  'fixture-trakt-access-token',
  'fixture-trakt-refresh-token',
  'fixture-migration-secret',
];

let fixtureRoot;
let databasePath;

before(async () => {
  fixtureRoot = await mkdtemp(path.join(tmpdir(), 'seerr-inventory-'));
  databasePath = path.join(fixtureRoot, 'fixture.sqlite3');
  const database = await openDatabase(databasePath);
  try {
    await exec(
      database,
      `
        CREATE TABLE "user" (
          "id" integer PRIMARY KEY,
          "email" text NOT NULL,
          "username" text,
          "userType" integer NOT NULL,
          "plexId" integer,
          "jellyfinUserId" text,
          "permissions" integer NOT NULL,
          "movieQuotaLimit" integer,
          "movieQuotaDays" integer,
          "tvQuotaLimit" integer,
          "tvQuotaDays" integer,
          "password" text,
          "plexToken" text,
          "jellyfinToken" text,
          "traktAccessToken" text,
          "traktRefreshToken" text
        );
        INSERT INTO "user" VALUES
          (9, 'family@example.com', 'Family', 3, NULL, 'jf-family', 64, NULL, NULL, 2, 7,
            'fixture-password-secret', 'fixture-plex-token', 'fixture-jellyfin-token',
            'fixture-trakt-access-token', 'fixture-trakt-refresh-token'),
          (2, ' Admin@Example.COM ', 'Admin', 1, 12345, NULL, 2, 5, 30, 8, 60,
            'another-password', 'another-plex-token', NULL, NULL, NULL);

        CREATE TABLE "media" ("id" integer PRIMARY KEY);
        INSERT INTO "media" VALUES (41), (42);
        CREATE TABLE "media_request" (
          "id" integer PRIMARY KEY,
          "requestedById" integer,
          "mediaId" integer,
          "status" integer NOT NULL,
          "createdAt" text NOT NULL
        );
        INSERT INTO "media_request" VALUES
          (30, 9, 42, 3, '2026-01-02 03:04:05'),
          (10, 2, 41, 2, '2025-01-02 03:04:05'),
          (31, 2, 41, 1, '2026-01-02 03:04:05');

        CREATE TABLE "issue" ("id" integer PRIMARY KEY);
        INSERT INTO "issue" VALUES (1);
        CREATE TABLE "user_settings" ("id" integer PRIMARY KEY);
        INSERT INTO "user_settings" VALUES (1);
        CREATE TABLE "season" ("id" integer PRIMARY KEY);
        INSERT INTO "season" VALUES (1);
        CREATE TABLE "season_request" ("id" integer PRIMARY KEY);
        INSERT INTO "season_request" VALUES (1);
        CREATE TABLE "issue_comment" ("id" integer PRIMARY KEY);
        INSERT INTO "issue_comment" VALUES (1);
        CREATE TABLE "user_push_subscription" ("id" integer PRIMARY KEY);
        INSERT INTO "user_push_subscription" VALUES (1);
        CREATE TABLE "watchlist" ("id" integer PRIMARY KEY);
        INSERT INTO "watchlist" VALUES (1);
        CREATE TABLE "blocklist" ("id" integer PRIMARY KEY);
        INSERT INTO "blocklist" VALUES (1);
        CREATE TABLE "override_rule" ("id" integer PRIMARY KEY);
        INSERT INTO "override_rule" VALUES (1);
        CREATE TABLE "discover_slider" ("id" integer PRIMARY KEY);
        INSERT INTO "discover_slider" VALUES (1);
        CREATE TABLE "trakt_connection" (
          "id" integer PRIMARY KEY,
          "accessToken" text,
          "refreshToken" text
        );
        INSERT INTO "trakt_connection" VALUES
          (1, 'fixture-trakt-access-token', 'fixture-trakt-refresh-token');

        CREATE TABLE "migrations" (
          "id" integer PRIMARY KEY,
          "timestamp" integer NOT NULL,
          "name" text NOT NULL,
          "secretMetadata" text
        );
        INSERT INTO "migrations" VALUES
          (1, 20, 'ZuluMigration20', 'fixture-migration-secret'),
          (2, 10, 'AlphaMigration10', 'another-migration-secret');
      `
    );
  } finally {
    await close(database);
  }
});

after(async () => {
  if (fixtureRoot) {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('emits deterministic safe counts, users, boundaries, and schema metadata', async () => {
  const createInventory = await loadCreateInventory();
  assert.equal(
    typeof createInventory,
    'function',
    'createInventory must exist'
  );

  const inventory = await createInventory(databasePath);
  const serialized = JSON.stringify(inventory);

  assert.deepEqual(inventory, {
    integrity: 'ok',
    counts: {
      user: 2,
      media: 2,
      media_request: 3,
      issue: 1,
      user_settings: 1,
      season: 1,
      season_request: 1,
      issue_comment: 1,
      user_push_subscription: 1,
      watchlist: 1,
      blocklist: 1,
      override_rule: 1,
      discover_slider: 1,
      trakt_connection: 1,
    },
    users: [
      {
        id: 2,
        emailSha256: hashEmail(' Admin@Example.COM '),
        username: 'Admin',
        userType: 1,
        plexId: 12345,
        jellyfinUserId: null,
        permissions: 2,
        movieQuotaLimit: 5,
        movieQuotaDays: 30,
        tvQuotaLimit: 8,
        tvQuotaDays: 60,
      },
      {
        id: 9,
        emailSha256: hashEmail('family@example.com'),
        username: 'Family',
        userType: 3,
        plexId: null,
        jellyfinUserId: 'jf-family',
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
        requestedById: 2,
        mediaId: 41,
        status: 2,
        createdAt: '2025-01-02 03:04:05',
      },
      newest: {
        id: 31,
        requestedById: 2,
        mediaId: 41,
        status: 1,
        createdAt: '2026-01-02 03:04:05',
      },
    },
    schema: {
      legacyUserTraktColumns: ['traktAccessToken', 'traktRefreshToken'],
      migrationNames: ['AlphaMigration10', 'ZuluMigration20'],
    },
  });
  for (const secret of fixtureSecrets) {
    assert.equal(
      serialized.includes(secret),
      false,
      `inventory leaked ${secret}`
    );
  }
});

test('uses zero counts and null boundaries for tables that do not exist', async () => {
  const createInventory = await loadCreateInventory();
  assert.equal(
    typeof createInventory,
    'function',
    'createInventory must exist'
  );
  const sparsePath = path.join(fixtureRoot, 'sparse.sqlite3');
  const sparseDatabase = await openDatabase(sparsePath);
  await exec(sparseDatabase, 'CREATE TABLE migrations (name text NOT NULL);');
  await close(sparseDatabase);

  const inventory = await createInventory(sparsePath);

  assert.deepEqual(Object.values(inventory.counts), Array(14).fill(0));
  assert.deepEqual(inventory.users, []);
  assert.deepEqual(inventory.requests, { oldest: null, newest: null });
  assert.deepEqual(inventory.schema, {
    legacyUserTraktColumns: [],
    migrationNames: [],
  });
});

test('rejects a relative database path', async () => {
  const createInventory = await loadCreateInventory();
  assert.equal(
    typeof createInventory,
    'function',
    'createInventory must exist'
  );
  await assert.rejects(createInventory('db.sqlite3'), /absolute path/);
});
