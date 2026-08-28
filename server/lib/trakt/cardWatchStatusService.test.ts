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
    const watcher = await saveUser(3);
    const rest = await saveUser(4);
    const viewerConnection = await saveConnection(viewer);
    const watcherConnection = await saveConnection(watcher);
    const restConnection = await saveConnection(rest);
    await traktWatchedItemRepository.reconcile(viewerConnection.id, []);
    await traktWatchedItemRepository.reconcile(watcherConnection.id, [
      {
        mediaType: 'movie',
        tmdbId: 1,
        watchedEpisodes: 1,
        airedEpisodes: null,
        lastWatchedAt: null,
      },
    ]);
    await traktWatchedItemRepository.reconcile(restConnection.id, []);

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
});
