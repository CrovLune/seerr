import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, link, open, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sqlite3 from 'sqlite3';

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

const closeDatabase = (database) =>
  new Promise((resolve, reject) => {
    database.close((error) => (error ? reject(error) : resolve()));
  });

const backUp = (database, destinationPath) =>
  new Promise((resolve, reject) => {
    const backup = database.backup(destinationPath, (initializeError) => {
      if (initializeError) {
        reject(initializeError);
        return;
      }
      backup.step(-1, (stepError) => {
        backup.finish((finishError) => {
          if (stepError) {
            reject(stepError);
          } else if (finishError) {
            reject(finishError);
          } else {
            resolve();
          }
        });
      });
    });
  });

const integrityCheck = (database) =>
  new Promise((resolve, reject) => {
    database.all('PRAGMA integrity_check', (error, rows) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(rows.map((row) => row.integrity_check));
    });
  });

const setStandaloneJournalMode = (database) =>
  new Promise((resolve, reject) => {
    database.get('PRAGMA journal_mode = DELETE', (error, row) => {
      if (error) {
        reject(error);
        return;
      }
      if (row?.journal_mode !== 'delete') {
        reject(
          new Error(
            `standalone journal mode failed: ${row?.journal_mode ?? 'unknown'}`
          )
        );
        return;
      }
      resolve();
    });
  });

const assertDestinationAbsent = async (destinationPath) => {
  try {
    await access(destinationPath, constants.F_OK);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  throw new Error(`destination already exists: ${destinationPath}`);
};

export const promoteVerifiedPartial = async (
  partialPath,
  destinationPath,
  { removePartial = unlink } = {}
) => {
  try {
    await link(partialPath, destinationPath);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`destination already exists: ${destinationPath}`, {
        cause: error,
      });
    }
    throw error;
  }

  try {
    await removePartial(partialPath);
    return { partialRetained: false, partialPath: null };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { partialRetained: false, partialPath: null };
    }
    return { partialRetained: true, partialPath };
  }
};

export const backupDatabase = async (sourcePath, destinationPath) => {
  if (!path.isAbsolute(sourcePath) || !path.isAbsolute(destinationPath)) {
    throw new Error('source and destination must be absolute paths');
  }
  if (sourcePath === destinationPath) {
    throw new Error('source and destination must be different absolute paths');
  }

  await assertDestinationAbsent(destinationPath);

  const partialPath = path.join(
    path.dirname(destinationPath),
    `.${path.basename(destinationPath)}.partial-${process.pid}-${randomUUID()}`
  );
  let sourceDatabase;
  let partialDatabase;

  try {
    const partialHandle = await open(partialPath, 'wx');
    await partialHandle.close();

    sourceDatabase = await openDatabase(sourcePath, sqlite3.OPEN_READONLY);
    await backUp(sourceDatabase, partialPath);
    await closeDatabase(sourceDatabase);
    sourceDatabase = undefined;

    partialDatabase = await openDatabase(partialPath, sqlite3.OPEN_READWRITE);
    await setStandaloneJournalMode(partialDatabase);
    const integrityRows = await integrityCheck(partialDatabase);
    await closeDatabase(partialDatabase);
    partialDatabase = undefined;

    if (integrityRows.length !== 1 || integrityRows[0] !== 'ok') {
      throw new Error(`integrity check failed: ${integrityRows.join(', ')}`);
    }

    const partialStat = await stat(partialPath);
    const promotion = await promoteVerifiedPartial(
      partialPath,
      destinationPath
    );

    return {
      sourcePath,
      destinationPath,
      bytes: partialStat.size,
      integrity: 'ok',
      partialRetained: promotion.partialRetained,
      partialPath: promotion.partialPath,
    };
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; partial database retained at ${partialPath}`,
      { cause: error }
    );
  } finally {
    if (partialDatabase) {
      await closeDatabase(partialDatabase).catch(() => {});
    }
    if (sourceDatabase) {
      await closeDatabase(sourceDatabase).catch(() => {});
    }
  }
};

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  if (process.argv.length !== 4) {
    console.error(
      'usage: sqlite-backup.mjs SOURCE_DATABASE DESTINATION_DATABASE'
    );
    process.exitCode = 1;
  } else {
    try {
      const result = await backupDatabase(process.argv[2], process.argv[3]);
      console.log(`source path: ${result.sourcePath}`);
      console.log(`destination path: ${result.destinationPath}`);
      console.log(`byte count: ${result.bytes}`);
      console.log(`integrity result: ${result.integrity}`);
      console.log(
        result.partialRetained
          ? `partial cleanup result: retained at ${result.partialPath}`
          : 'partial cleanup result: removed'
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
