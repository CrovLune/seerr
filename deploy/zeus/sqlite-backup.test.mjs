import assert from 'node:assert/strict';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import sqlite3 from 'sqlite3';

const helperUrl = new URL('./sqlite-backup.mjs', import.meta.url);

const loadBackupDatabase = async () => {
  try {
    const module = await import(helperUrl);
    return module.backupDatabase;
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      return undefined;
    }
    throw error;
  }
};

const openDatabase = (databasePath, mode) =>
  new Promise((resolve, reject) => {
    const database = new sqlite3.Database(databasePath, mode, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve(database);
      }
    });
  });

const exec = (database, sql) =>
  new Promise((resolve, reject) => {
    database.exec(sql, (error) => (error ? reject(error) : resolve()));
  });

const all = (database, sql) =>
  new Promise((resolve, reject) => {
    database.all(sql, (error, rows) => (error ? reject(error) : resolve(rows)));
  });

const close = (database) =>
  new Promise((resolve, reject) => {
    database.close((error) => (error ? reject(error) : resolve()));
  });

let fixtureRoot;
let sourcePath;
let sourceDatabase;

before(async () => {
  fixtureRoot = await mkdtemp(path.join(tmpdir(), 'seerr-sqlite-backup-'));
  sourcePath = path.join(fixtureRoot, 'source.sqlite3');
  sourceDatabase = await openDatabase(
    sourcePath,
    sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE
  );
  await exec(
    sourceDatabase,
    `
      PRAGMA journal_mode = WAL;
      CREATE TABLE example (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      BEGIN;
      INSERT INTO example (value) VALUES ('alpha'), ('beta');
      COMMIT;
    `
  );
});

after(async () => {
  if (sourceDatabase) {
    await close(sourceDatabase);
  }
  if (fixtureRoot) {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('creates a consistent atomic backup of committed WAL data', async () => {
  const backupDatabase = await loadBackupDatabase();
  assert.equal(typeof backupDatabase, 'function', 'backupDatabase must exist');

  const destinationPath = path.join(fixtureRoot, 'destination.sqlite3');
  const result = await backupDatabase(sourcePath, destinationPath);
  const destinationDatabase = await openDatabase(
    destinationPath,
    sqlite3.OPEN_READONLY
  );

  try {
    assert.deepEqual(
      await all(
        destinationDatabase,
        'SELECT id, value FROM example ORDER BY id'
      ),
      await all(sourceDatabase, 'SELECT id, value FROM example ORDER BY id')
    );
    assert.deepEqual(await all(destinationDatabase, 'PRAGMA integrity_check'), [
      { integrity_check: 'ok' },
    ]);
    assert.equal(result.sourcePath, sourcePath);
    assert.equal(result.destinationPath, destinationPath);
    assert.equal(result.integrity, 'ok');
    assert.ok(result.bytes > 0);
  } finally {
    await close(destinationDatabase);
  }
});

test('rejects identical source and destination paths', async () => {
  const backupDatabase = await loadBackupDatabase();
  assert.equal(typeof backupDatabase, 'function', 'backupDatabase must exist');
  await assert.rejects(
    backupDatabase(sourcePath, sourcePath),
    /different absolute paths/
  );
});

test('rejects a relative path', async () => {
  const backupDatabase = await loadBackupDatabase();
  assert.equal(typeof backupDatabase, 'function', 'backupDatabase must exist');
  await assert.rejects(
    backupDatabase(
      'source.sqlite3',
      path.join(fixtureRoot, 'relative.sqlite3')
    ),
    /absolute paths/
  );
});

test('rejects an existing destination without modifying it', async () => {
  const backupDatabase = await loadBackupDatabase();
  assert.equal(typeof backupDatabase, 'function', 'backupDatabase must exist');
  const destinationPath = path.join(fixtureRoot, 'existing.sqlite3');
  const destination = await open(destinationPath, 'wx');
  await destination.writeFile('existing evidence');
  await destination.close();

  await assert.rejects(
    backupDatabase(sourcePath, destinationPath),
    /destination already exists/
  );
});
