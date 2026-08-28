import { getRepository } from '@server/datasource';
import {
  TraktConnection,
  TraktConnectionStatus,
} from '@server/entity/TraktConnection';
import { User } from '@server/entity/User';
import type { TraktCardWatcher } from '@server/interfaces/api/traktInterfaces';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  deriveState,
  traktCardWatchStatusService,
} from './cardWatchStatusService';
import { traktWatchedItemRepository } from './watchedItemRepository';

setupTestDb();

const users = () => getRepository(User);
const connections = () => getRepository(TraktConnection);

const admin = () => users().findOneByOrFail({ email: 'admin@seerr.dev' });

async function saveUser(index: number): Promise<User> {
  return users().save(
    new User({
      email: `household-${index}@seerr.dev`,
      username: `Household ${index}`,
      permissions: 0,
      avatar: `avatar-${index}`,
    })
  );
}

async function saveConnection(user: User): Promise<TraktConnection> {
  return connections().save(
    connections().create({
      userId: user.id,
      traktUserId: `trakt-${user.id}`,
      username: `trakt-user-${user.id}`,
      status: TraktConnectionStatus.ACTIVE,
      accessToken: 'secret-access-token',
      refreshToken: 'secret-refresh-token',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })
  );
}

describe('deriveState', () => {
  it('returns not_started when there is no row', () => {
    assert.equal(deriveState(undefined), 'not_started');
  });

  it('returns complete for any movie row', () => {
    assert.equal(
      deriveState({
        mediaType: 'movie',
        watchedEpisodes: 1,
        airedEpisodes: null,
      }),
      'complete'
    );
  });

  it('returns partial when fewer episodes are watched than aired', () => {
    assert.equal(
      deriveState({ mediaType: 'tv', watchedEpisodes: 3, airedEpisodes: 10 }),
      'partial'
    );
  });

  it('returns complete when caught up on everything aired', () => {
    assert.equal(
      deriveState({ mediaType: 'tv', watchedEpisodes: 10, airedEpisodes: 10 }),
      'complete'
    );
  });

  it('returns partial, not complete, when watched exceeds aired', () => {
    assert.equal(
      deriveState({ mediaType: 'tv', watchedEpisodes: 12, airedEpisodes: 10 }),
      'partial'
    );
  });

  it('returns partial when aired is zero and a row exists', () => {
    assert.equal(
      deriveState({ mediaType: 'tv', watchedEpisodes: 2, airedEpisodes: 0 }),
      'partial'
    );
  });
});

describe('traktCardWatchStatusService.getBatch', () => {
  it('omits a connection that has never synced successfully', async () => {
    const viewer = await admin();
    const synced = await saveUser(1);
    const unsynced = await saveUser(2);
    const syncedConnection = await saveConnection(synced);
    await saveConnection(unsynced);
    await traktWatchedItemRepository.reconcile(syncedConnection.id, [
      {
        mediaType: 'movie',
        tmdbId: 1,
        watchedEpisodes: 1,
        airedEpisodes: null,
        lastWatchedAt: null,
      },
    ]);

    const response = await traktCardWatchStatusService.getBatch({
      viewer,
      items: [{ mediaType: 'movie', tmdbId: 1 }],
    });

    assert.deepEqual(
      response.results[0]!.watchers.map((w: TraktCardWatcher) => w.userId),
      [synced.id]
    );
  });

  it('excludes omitted connections from totalWatchers', async () => {
    const viewer = await admin();
    const synced = await saveUser(1);
    const unsynced = await saveUser(2);
    const syncedConnection = await saveConnection(synced);
    await saveConnection(unsynced);
    await traktWatchedItemRepository.reconcile(syncedConnection.id, [
      {
        mediaType: 'movie',
        tmdbId: 1,
        watchedEpisodes: 1,
        airedEpisodes: null,
        lastWatchedAt: null,
      },
    ]);

    const response = await traktCardWatchStatusService.getBatch({
      viewer,
      items: [{ mediaType: 'movie', tmdbId: 1 }],
    });

    assert.equal(response.results[0]!.totalWatchers, 1);
  });

  it('orders the viewer first, then watchers, then the rest', async () => {
    const viewer = await admin();
    // `rest` is created (and thus gets a lower id) before `watcher`, so plain
    // `ORDER BY userId ASC` would yield [viewer, rest, watcher] -- disagreeing with the
    // intended [viewer, watcher, rest]. This is what makes the test fail if the
    // viewer-then-watched-then-rest grouping were ever dropped.
    const rest = await saveUser(4);
    const watcher = await saveUser(3);
    const viewerConnection = await saveConnection(viewer);
    const restConnection = await saveConnection(rest);
    const watcherConnection = await saveConnection(watcher);
    await traktWatchedItemRepository.reconcile(viewerConnection.id, []);
    await traktWatchedItemRepository.reconcile(restConnection.id, []);
    await traktWatchedItemRepository.reconcile(watcherConnection.id, [
      {
        mediaType: 'movie',
        tmdbId: 1,
        watchedEpisodes: 1,
        airedEpisodes: null,
        lastWatchedAt: null,
      },
    ]);

    const response = await traktCardWatchStatusService.getBatch({
      viewer,
      items: [{ mediaType: 'movie', tmdbId: 1 }],
    });

    assert.equal(response.results[0]!.watchers[0]!.userId, viewer.id);
    assert.deepEqual(
      response.results[0]!.watchers.map((w: TraktCardWatcher) => w.userId),
      [viewer.id, watcher.id, rest.id]
    );
  });

  it('shows only the viewer connection to a non-admin viewer', async () => {
    const viewer = await saveUser(5);
    const other = await saveUser(6);
    const viewerConnection = await saveConnection(viewer);
    const otherConnection = await saveConnection(other);
    await traktWatchedItemRepository.reconcile(viewerConnection.id, []);
    await traktWatchedItemRepository.reconcile(otherConnection.id, [
      {
        mediaType: 'movie',
        tmdbId: 1,
        watchedEpisodes: 1,
        airedEpisodes: null,
        lastWatchedAt: null,
      },
    ]);

    const response = await traktCardWatchStatusService.getBatch({
      viewer,
      items: [{ mediaType: 'movie', tmdbId: 1 }],
    });

    assert.deepEqual(
      response.results[0]!.watchers.map((w: TraktCardWatcher) => w.userId),
      [viewer.id]
    );
    assert.equal(response.results[0]!.totalWatchers, 1);
  });

  it('sets viewerState to the derived state for an eligible viewer connection', async () => {
    const viewer = await admin();
    const viewerConnection = await saveConnection(viewer);
    await traktWatchedItemRepository.reconcile(viewerConnection.id, [
      {
        mediaType: 'movie',
        tmdbId: 1,
        watchedEpisodes: 1,
        airedEpisodes: null,
        lastWatchedAt: null,
      },
    ]);

    const response = await traktCardWatchStatusService.getBatch({
      viewer,
      items: [{ mediaType: 'movie', tmdbId: 1 }],
    });

    assert.equal(response.results[0]!.viewerState, 'complete');
  });

  it('sets viewerState to null when the viewer has no eligible connection', async () => {
    const viewer = await admin();
    await saveConnection(viewer);

    const response = await traktCardWatchStatusService.getBatch({
      viewer,
      items: [{ mediaType: 'movie', tmdbId: 1 }],
    });

    assert.equal(response.results[0]!.viewerState, null);
  });
});
