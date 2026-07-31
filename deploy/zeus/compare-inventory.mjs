import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const legacyCountTables = [
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
];

const safeUserFields = [
  'id',
  'emailSha256',
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

const requestBoundaryFields = [
  'id',
  'requestedById',
  'mediaId',
  'status',
  'createdAt',
];

const requiredMigrations = [
  'SeerrMigration1759769291608',
  'AddTraktConnections1785456000000',
];

const compareValue = (sourceValue, migratedValue) =>
  Object.is(sourceValue, migratedValue);

const compareUsers = (sourceUsers, migratedUsers) => {
  if (!Array.isArray(sourceUsers) || !Array.isArray(migratedUsers)) {
    throw new Error('user inventory is not an array');
  }
  if (sourceUsers.length !== migratedUsers.length) {
    throw new Error('user inventory length mismatch');
  }
  for (let index = 0; index < sourceUsers.length; index += 1) {
    for (const field of safeUserFields) {
      if (
        !Object.hasOwn(sourceUsers[index] ?? {}, field) ||
        !Object.hasOwn(migratedUsers[index] ?? {}, field)
      ) {
        throw new Error(`invalid user record at index ${index}: ${field}`);
      }
      if (
        !compareValue(
          sourceUsers[index]?.[field],
          migratedUsers[index]?.[field]
        )
      ) {
        throw new Error(`user mismatch at index ${index}: ${field}`);
      }
    }
  }
};

const compareBoundary = (sourceBoundary, migratedBoundary, boundaryName) => {
  if (sourceBoundary === null || migratedBoundary === null) {
    if (sourceBoundary !== migratedBoundary) {
      throw new Error(`request ${boundaryName} mismatch: record presence`);
    }
    return;
  }
  for (const field of requestBoundaryFields) {
    if (
      !Object.hasOwn(sourceBoundary, field) ||
      !Object.hasOwn(migratedBoundary, field)
    ) {
      throw new Error(`invalid request ${boundaryName} record: ${field}`);
    }
    if (!compareValue(sourceBoundary?.[field], migratedBoundary?.[field])) {
      throw new Error(`request ${boundaryName} mismatch: ${field}`);
    }
  }
};

export const compareInventories = (source, migrated) => {
  if (source?.integrity !== 'ok') {
    throw new Error('source integrity is not ok');
  }
  if (migrated?.integrity !== 'ok') {
    throw new Error('migrated integrity is not ok');
  }

  for (const tableName of legacyCountTables) {
    if (
      !Number.isInteger(source?.counts?.[tableName]) ||
      source.counts[tableName] < 0 ||
      !Number.isInteger(migrated?.counts?.[tableName]) ||
      migrated.counts[tableName] < 0
    ) {
      throw new Error(`invalid count for ${tableName}`);
    }
    if (
      !compareValue(source?.counts?.[tableName], migrated?.counts?.[tableName])
    ) {
      throw new Error(`count mismatch for ${tableName}`);
    }
  }

  compareUsers(source?.users, migrated?.users);
  compareBoundary(
    source?.requests?.oldest,
    migrated?.requests?.oldest,
    'oldest'
  );
  compareBoundary(
    source?.requests?.newest,
    migrated?.requests?.newest,
    'newest'
  );

  const legacyColumns = migrated?.schema?.legacyUserTraktColumns;
  if (!Array.isArray(legacyColumns) || legacyColumns.length !== 0) {
    throw new Error('legacy Trakt columns remain in migrated database');
  }

  const migrationNames = migrated?.schema?.migrationNames;
  if (!Array.isArray(migrationNames)) {
    throw new Error('migrated migration names are not an array');
  }
  for (const migrationName of requiredMigrations) {
    if (!migrationNames.includes(migrationName)) {
      throw new Error(`required migration missing: ${migrationName}`);
    }
  }

  if (migrated?.counts?.trakt_connection !== 0) {
    throw new Error('trakt_connection must be empty after migration');
  }

  return 'ok';
};

export const compareInventoryFiles = async (sourcePath, migratedPath) => {
  if (!path.isAbsolute(sourcePath) || !path.isAbsolute(migratedPath)) {
    throw new Error('source and migrated inventories must use absolute paths');
  }
  const [source, migrated] = await Promise.all([
    readFile(sourcePath, 'utf8').then(JSON.parse),
    readFile(migratedPath, 'utf8').then(JSON.parse),
  ]);
  return compareInventories(source, migrated);
};

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  if (process.argv.length !== 4) {
    console.error(
      'usage: compare-inventory.mjs SOURCE_INVENTORY MIGRATED_INVENTORY'
    );
    process.exitCode = 1;
  } else {
    try {
      console.log(
        `inventory comparison: ${await compareInventoryFiles(process.argv[2], process.argv[3])}`
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
