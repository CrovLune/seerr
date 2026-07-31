import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, readdir, rm, stat } from 'node:fs/promises';
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

const loadPromoteVerifiedPartial = async () => {
  const module = await import(helperUrl);
  return module.promoteVerifiedPartial;
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

test('atomically rejects a destination that exists at promotion time', async () => {
  const promoteVerifiedPartial = await loadPromoteVerifiedPartial();
  assert.equal(
    typeof promoteVerifiedPartial,
    'function',
    'promoteVerifiedPartial must exist'
  );
  const partialPath = path.join(fixtureRoot, '.promotion.partial');
  const destinationPath = path.join(fixtureRoot, 'promotion.sqlite3');
  const partialContents = 'verified partial database';
  const existingEvidence = 'existing destination evidence';
  const partial = await open(partialPath, 'wx');
  await partial.writeFile(partialContents);
  await partial.close();
  const destination = await open(destinationPath, 'wx');
  await destination.writeFile(existingEvidence);
  await destination.close();

  await assert.rejects(
    promoteVerifiedPartial(partialPath, destinationPath),
    /destination already exists/
  );
  assert.equal(await readFile(destinationPath, 'utf8'), existingEvidence);
  assert.equal(await readFile(partialPath, 'utf8'), partialContents);
});

test('retains and reports a partial after a corrupt source backup fails', async () => {
  const backupDatabase = await loadBackupDatabase();
  assert.equal(typeof backupDatabase, 'function', 'backupDatabase must exist');
  const corruptSourcePath = path.join(fixtureRoot, 'corrupt.sqlite3');
  const destinationPath = path.join(fixtureRoot, 'corrupt-backup.sqlite3');
  const corruptSource = await open(corruptSourcePath, 'wx');
  await corruptSource.writeFile('not a SQLite database');
  await corruptSource.close();

  let reportedPartialPath;
  await assert.rejects(
    backupDatabase(corruptSourcePath, destinationPath),
    (error) => {
      const match = error.message.match(/partial database retained at (.+)$/);
      assert.ok(match, 'failure must report the retained partial path');
      reportedPartialPath = match[1];
      return true;
    }
  );

  await assert.rejects(stat(destinationPath), { code: 'ENOENT' });
  assert.equal(path.dirname(reportedPartialPath), fixtureRoot);
  assert.ok(
    (await readdir(fixtureRoot)).includes(path.basename(reportedPartialPath))
  );
  assert.ok((await stat(reportedPartialPath)).isFile());
});
