import { getRepository } from '@server/datasource';
import {
  TraktConnection,
  TraktConnectionStatus,
} from '@server/entity/TraktConnection';
import { TraktWatchedItem } from '@server/entity/TraktWatchedItem';
import { User } from '@server/entity/User';
import type { WatchedSnapshotItem } from '@server/lib/trakt/watchedLibrarySync';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { traktWatchedItemRepository } from './watchedItemRepository';

setupTestDb();

const seedConnection = async (): Promise<number> => {
  const owner = await getRepository(User).save(
    getRepository(User).create({
      email: `${randomUUID()}@seerr.dev`,
      avatar: 'https://seerr.dev/avatar.png',
    })
  );
  const connection = await getRepository(TraktConnection).save(
    getRepository(TraktConnection).create({
      userId: owner.id,
      traktUserId: randomUUID(),
      status: TraktConnectionStatus.ACTIVE,
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: new Date(Date.now() + 3_600_000),
    })
  );
  return connection.id;
};

describe('traktWatchedItemRepository.reconcile', () => {
  it('persists rows and reads back the stored values', async () => {
    const connectionId = await seedConnection();

    await traktWatchedItemRepository.reconcile(connectionId, [
      {
        mediaType: 'tv',
        tmdbId: 42,
        watchedEpisodes: 3,
        airedEpisodes: 10,
        lastWatchedAt: new Date('2026-05-05'),
      },
    ]);

    const stored = await getRepository(TraktWatchedItem).findOneOrFail({
      where: { connectionId, mediaType: 'tv', tmdbId: 42 },
    });
    assert.equal(stored.watchedEpisodes, 3);
    assert.equal(stored.airedEpisodes, 10);
    assert.equal(
      stored.lastWatchedAt?.toISOString(),
      '2026-05-05T00:00:00.000Z'
    );
  });

  it('is idempotent — reconciling the same snapshot twice leaves one row', async () => {
    const connectionId = await seedConnection();
    const snapshot: WatchedSnapshotItem[] = [
      {
        mediaType: 'movie',
        tmdbId: 1,
        watchedEpisodes: 1,
        airedEpisodes: null,
        lastWatchedAt: null,
      },
    ];

    await traktWatchedItemRepository.reconcile(connectionId, snapshot);
    await traktWatchedItemRepository.reconcile(connectionId, snapshot);

    const rows = await getRepository(TraktWatchedItem).find({
      where: { connectionId },
    });
    assert.equal(rows.length, 1);
  });

  it('overwrites stale values for a key that reappears with new data', async () => {
    const connectionId = await seedConnection();

    await traktWatchedItemRepository.reconcile(connectionId, [
      {
        mediaType: 'tv',
        tmdbId: 7,
        watchedEpisodes: 2,
        airedEpisodes: 10,
        lastWatchedAt: new Date('2026-01-01'),
      },
    ]);
    await traktWatchedItemRepository.reconcile(connectionId, [
      {
        mediaType: 'tv',
        tmdbId: 7,
        watchedEpisodes: 5,
        airedEpisodes: 12,
        lastWatchedAt: new Date('2026-02-02'),
      },
    ]);

    const stored = await getRepository(TraktWatchedItem).findOneOrFail({
      where: { connectionId, mediaType: 'tv', tmdbId: 7 },
    });
    assert.equal(stored.watchedEpisodes, 5);
    assert.equal(stored.airedEpisodes, 12);
    assert.equal(
      stored.lastWatchedAt?.toISOString(),
      '2026-02-02T00:00:00.000Z'
    );
  });

  it('deletes rows absent from the new snapshot', async () => {
    const connectionId = await seedConnection();
    await traktWatchedItemRepository.reconcile(connectionId, [
      {
        mediaType: 'movie',
        tmdbId: 1,
        watchedEpisodes: 1,
        airedEpisodes: null,
        lastWatchedAt: null,
      },
      {
        mediaType: 'movie',
        tmdbId: 2,
        watchedEpisodes: 1,
        airedEpisodes: null,
        lastWatchedAt: null,
      },
    ]);

    await traktWatchedItemRepository.reconcile(connectionId, [
      {
        mediaType: 'movie',
        tmdbId: 2,
        watchedEpisodes: 1,
        airedEpisodes: null,
        lastWatchedAt: null,
      },
    ]);

    const rows = await getRepository(TraktWatchedItem).find({
      where: { connectionId },
    });
    assert.deepEqual(
      rows.map((r) => r.tmdbId),
      [2]
    );
  });

  it('deletes every row when reconciled against an empty snapshot', async () => {
    const connectionId = await seedConnection();
    await traktWatchedItemRepository.reconcile(connectionId, [
      {
        mediaType: 'movie',
        tmdbId: 1,
        watchedEpisodes: 1,
        airedEpisodes: null,
        lastWatchedAt: null,
      },
    ]);

    await traktWatchedItemRepository.reconcile(connectionId, []);

    const rows = await getRepository(TraktWatchedItem).find({
      where: { connectionId },
    });
    assert.equal(rows.length, 0);
  });

  it('stamps lastWatchedSuccessfulSyncAt in the same transaction', async () => {
    const connectionId = await seedConnection();
    const before = Date.now();

    await traktWatchedItemRepository.reconcile(connectionId, []);

    const connection = await getRepository(TraktConnection).findOneOrFail({
      where: { id: connectionId },
    });
    assert.ok(connection.lastWatchedSuccessfulSyncAt instanceof Date);
    assert.ok(connection.lastWatchedSuccessfulSyncAt.getTime() >= before);
  });

  it('removes rows when the connection is deleted', async () => {
    const connectionId = await seedConnection();
    await traktWatchedItemRepository.reconcile(connectionId, [
      {
        mediaType: 'movie',
        tmdbId: 9,
        watchedEpisodes: 1,
        airedEpisodes: null,
        lastWatchedAt: null,
      },
    ]);

    await getRepository(TraktConnection).delete({ id: connectionId });

    const rows = await getRepository(TraktWatchedItem).find({
      where: { connectionId },
    });
    assert.equal(rows.length, 0);
  });

  it('persists a snapshot spanning multiple upsert chunks', async () => {
    const connectionId = await seedConnection();
    const snapshot: WatchedSnapshotItem[] = Array.from(
      { length: 1_204 },
      (_, index) => ({
        mediaType: 'movie',
        tmdbId: index,
        watchedEpisodes: 1,
        airedEpisodes: null,
        lastWatchedAt: null,
      })
    );

    await traktWatchedItemRepository.reconcile(connectionId, snapshot);

    const rows = await getRepository(TraktWatchedItem).find({
      where: { connectionId },
    });
    assert.equal(rows.length, 1_204);
    const first = rows.find((row) => row.tmdbId === 0);
    const middle = rows.find((row) => row.tmdbId === 500);
    const boundary = rows.find((row) => row.tmdbId === 1_000);
    const last = rows.find((row) => row.tmdbId === 1_203);
    assert.ok(first);
    assert.ok(middle);
    assert.ok(boundary);
    assert.ok(last);
  });
});

describe('traktWatchedItemRepository.findForMedia', () => {
  it('returns an empty array without querying when either input is empty', async () => {
    const connectionId = await seedConnection();
    await traktWatchedItemRepository.reconcile(connectionId, [
      {
        mediaType: 'movie',
        tmdbId: 1,
        watchedEpisodes: 1,
        airedEpisodes: null,
        lastWatchedAt: null,
      },
    ]);

    assert.deepEqual(
      await traktWatchedItemRepository.findForMedia(
        [],
        [{ mediaType: 'movie', tmdbId: 1 }]
      ),
      []
    );
    assert.deepEqual(
      await traktWatchedItemRepository.findForMedia([connectionId], []),
      []
    );
  });

  it('finds rows for the requested connections and keys only', async () => {
    const connectionA = await seedConnection();
    const connectionB = await seedConnection();
    await traktWatchedItemRepository.reconcile(connectionA, [
      {
        mediaType: 'movie',
        tmdbId: 1,
        watchedEpisodes: 1,
        airedEpisodes: null,
        lastWatchedAt: null,
      },
      {
        mediaType: 'tv',
        tmdbId: 2,
        watchedEpisodes: 4,
        airedEpisodes: 4,
        lastWatchedAt: null,
      },
    ]);
    await traktWatchedItemRepository.reconcile(connectionB, [
      {
        mediaType: 'movie',
        tmdbId: 1,
        watchedEpisodes: 1,
        airedEpisodes: null,
        lastWatchedAt: null,
      },
      {
        mediaType: 'movie',
        tmdbId: 999,
        watchedEpisodes: 1,
        airedEpisodes: null,
        lastWatchedAt: null,
      },
    ]);

    const found = await traktWatchedItemRepository.findForMedia(
      [connectionA, connectionB],
      [
        { mediaType: 'movie', tmdbId: 1 },
        { mediaType: 'tv', tmdbId: 2 },
      ]
    );

    assert.equal(found.length, 3);
    assert.deepEqual(
      found
        .map((row) => `${row.connectionId}:${row.mediaType}:${row.tmdbId}`)
        .sort(),
      [
        `${connectionA}:movie:1`,
        `${connectionA}:tv:2`,
        `${connectionB}:movie:1`,
      ].sort()
    );
  });

  it('excludes connections not in the requested list', async () => {
    const included = await seedConnection();
    const excluded = await seedConnection();
    await traktWatchedItemRepository.reconcile(included, [
      {
        mediaType: 'movie',
        tmdbId: 5,
        watchedEpisodes: 1,
        airedEpisodes: null,
        lastWatchedAt: null,
      },
    ]);
    await traktWatchedItemRepository.reconcile(excluded, [
      {
        mediaType: 'movie',
        tmdbId: 5,
        watchedEpisodes: 1,
        airedEpisodes: null,
        lastWatchedAt: null,
      },
    ]);

    const found = await traktWatchedItemRepository.findForMedia(
      [included],
      [{ mediaType: 'movie', tmdbId: 5 }]
    );

    assert.equal(found.length, 1);
    assert.equal(found[0].connectionId, included);
  });
});
