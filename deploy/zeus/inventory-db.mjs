import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sqlite3 from 'sqlite3';

const countTables = [
  'user',
  'media',
  'media_request',
  'issue',
  'user_settings',
  'season',
  'season_request',
  'issue_comment',
  'user_push_subscription',
  'watchlist',
  'blocklist',
  'override_rule',
  'discover_slider',
  'trakt_connection',
];

const safeUserColumns = [
  'id',
  'email',
  'username',
  'userType',
  'plexId',
  'jellyfinUserId',
  'permissions',
  'movieQuotaLimit',
  'movieQuotaDays',
  'tvQuotaLimit',
  'tvQuotaDays',
];

const openDatabase = (databasePath) =>
  new Promise((resolve, reject) => {
    const database = new sqlite3.Database(
      databasePath,
      sqlite3.OPEN_READONLY,
      (error) => (error ? reject(error) : resolve(database))
    );
  });

const closeDatabase = (database) =>
  new Promise((resolve, reject) => {
    database.close((error) => (error ? reject(error) : resolve()));
  });

const all = (database, sql, parameters = []) =>
  new Promise((resolve, reject) => {
    database.all(sql, parameters, (error, rows) =>
      error ? reject(error) : resolve(rows)
    );
  });

const get = (database, sql, parameters = []) =>
  new Promise((resolve, reject) => {
    database.get(sql, parameters, (error, row) =>
      error ? reject(error) : resolve(row)
    );
  });

const tableExists = async (database, tableName) => {
  const row = await get(
    database,
    "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?",
    [tableName]
  );
  return row?.present === 1;
};

const tableColumns = async (database, tableName) => {
  if (!(await tableExists(database, tableName))) {
    return [];
  }
  return all(database, `PRAGMA table_info("${tableName}")`);
};

const countTable = async (database, tableName) => {
  if (!(await tableExists(database, tableName))) {
    return 0;
  }
  const row = await get(
    database,
    `SELECT COUNT(*) AS count FROM "${tableName}"`
  );
  return row.count;
};

const emailSha256 = (email) =>
  createHash('sha256')
    .update(
      String(email ?? '')
        .trim()
        .toLowerCase()
    )
    .digest('hex');

const lexicalCompare = (left, right) =>
  left < right ? -1 : left > right ? 1 : 0;

const readUsers = async (database, userColumns) => {
  if (userColumns.length === 0) {
    return [];
  }
  const presentColumns = new Set(userColumns.map((column) => column.name));
  const selections = safeUserColumns.map((column) =>
    presentColumns.has(column) ? `"${column}"` : `NULL AS "${column}"`
  );
  const rows = await all(
    database,
    `SELECT ${selections.join(', ')} FROM "user" ORDER BY "id" ASC`
  );

  return rows.map((row) => ({
    id: row.id,
    emailSha256: emailSha256(row.email),
    username: row.username ?? null,
    userType: row.userType ?? null,
    plexId: row.plexId ?? null,
    jellyfinUserId: row.jellyfinUserId ?? null,
    permissions: row.permissions ?? null,
    movieQuotaLimit: row.movieQuotaLimit ?? null,
    movieQuotaDays: row.movieQuotaDays ?? null,
    tvQuotaLimit: row.tvQuotaLimit ?? null,
    tvQuotaDays: row.tvQuotaDays ?? null,
  }));
};

const readRequestBoundary = async (database, direction) => {
  if (!(await tableExists(database, 'media_request'))) {
    return null;
  }
  const row = await get(
    database,
    `SELECT "id", "requestedById", "mediaId", "status", "createdAt"
       FROM "media_request"
      ORDER BY "createdAt" ${direction}, "id" ${direction}
      LIMIT 1`
  );
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    requestedById: row.requestedById ?? null,
    mediaId: row.mediaId ?? null,
    status: row.status,
    createdAt: row.createdAt,
  };
};

const readMigrationNames = async (database) => {
  if (!(await tableExists(database, 'migrations'))) {
    return [];
  }
  const columns = await tableColumns(database, 'migrations');
  if (!columns.some((column) => column.name === 'name')) {
    return [];
  }
  const rows = await all(database, 'SELECT "name" FROM "migrations"');
  return rows.map((row) => row.name).sort(lexicalCompare);
};

export const createInventory = async (databasePath) => {
  if (!path.isAbsolute(databasePath)) {
    throw new Error('database must use an absolute path');
  }

  const database = await openDatabase(databasePath);
  try {
    const integrityRows = await all(database, 'PRAGMA integrity_check');
    const integrity = integrityRows
      .map((row) => row.integrity_check)
      .join('; ');
    const counts = {};
    for (const tableName of countTables) {
      counts[tableName] = await countTable(database, tableName);
    }
    const userColumns = await tableColumns(database, 'user');
    const legacyUserTraktColumns = userColumns
      .map((column) => column.name)
      .filter((name) => name.toLowerCase().startsWith('trakt'))
      .sort(lexicalCompare);

    return {
      integrity,
      counts,
      users: await readUsers(database, userColumns),
      requests: {
        oldest: await readRequestBoundary(database, 'ASC'),
        newest: await readRequestBoundary(database, 'DESC'),
      },
      schema: {
        legacyUserTraktColumns,
        migrationNames: await readMigrationNames(database),
      },
    };
  } finally {
    await closeDatabase(database);
  }
};

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  if (process.argv.length !== 3) {
    console.error('usage: inventory-db.mjs DATABASE');
    process.exitCode = 1;
  } else {
    try {
      console.log(
        JSON.stringify(await createInventory(process.argv[2]), null, 2)
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
