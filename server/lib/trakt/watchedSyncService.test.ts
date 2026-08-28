import { getRepository } from '@server/datasource';
import {
  TraktConnection,
  TraktConnectionStatus,
} from '@server/entity/TraktConnection';
import { User } from '@server/entity/User';
import { traktAuthenticatedApiService } from '@server/lib/trakt/authenticatedApiService';
import { traktConnectionRepository } from '@server/lib/trakt/connectionRepository';
import { traktWatchedItemRepository } from '@server/lib/trakt/watchedItemRepository';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it, mock } from 'node:test';
import { traktWatchedSyncCoordinator } from './watchedSyncCoordinator';
import { traktWatchedSyncService } from './watchedSyncService';

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

const loadConnection = (connectionId: number): Promise<TraktConnection> =>
  getRepository(TraktConnection).findOneOrFail({
    where: { id: connectionId },
  });

const fakeApi = {
  getWatchedMovies: async () => [],
  getWatchedShows: async () => [],
};

afterEach(() => mock.restoreAll());

describe('traktWatchedSyncService.syncConnection', () => {
  it('reconciles outside the replayable authenticated callback', async () => {
    const connection = await loadConnection(await seedConnection());
    // Mimic a 401 replay: withAuthenticatedApi invokes its operation twice.
    mock.method(
      traktAuthenticatedApiService,
      'withAuthenticatedApi',
      async (
        _userId: number,
        operation: (api: unknown) => Promise<unknown>
      ) => {
        await operation(fakeApi);
        return operation(fakeApi);
      }
    );
    const reconcile = mock.method(
      traktWatchedItemRepository,
      'reconcile',
      async () => undefined
    );

    await traktWatchedSyncService.syncConnection(connection);

    assert.equal(
      reconcile.mock.calls.length,
      1,
      'reconcile must not be replayed with the callback'
    );
    assert.equal(reconcile.mock.calls[0].arguments[0], connection.id);
  });

  it('does not write anything when a page fetch fails', async () => {
    const connection = await loadConnection(await seedConnection());
    mock.method(
      traktAuthenticatedApiService,
      'withAuthenticatedApi',
      async (_userId: number, operation: (api: unknown) => Promise<unknown>) =>
        operation({
          ...fakeApi,
          getWatchedMovies: async () => {
            throw new Error('page 2 failed');
          },
        })
    );
    const reconcile = mock.method(
      traktWatchedItemRepository,
      'reconcile',
      async () => undefined
    );

    await traktWatchedSyncService.syncConnection(connection);

    assert.equal(reconcile.mock.calls.length, 0);
  });

  it('leaves lastWatchedSuccessfulSyncAt untouched and marks the connection failed', async () => {
    const connectionId = await seedConnection();
    mock.method(
      traktAuthenticatedApiService,
      'withAuthenticatedApi',
      async () => {
        throw new Error('boom');
      }
    );

    await traktWatchedSyncService.syncConnection(
      await loadConnection(connectionId)
    );

    const row = await getRepository(TraktConnection).findOneOrFail({
      where: { id: connectionId },
    });
    assert.equal(row.lastWatchedSuccessfulSyncAt, null);
    assert.equal(row.lastWatchedSyncStatus, 'failed');
  });
});

describe('traktWatchedSyncCoordinator', () => {
  it('serialises an overlapping scheduled and link-triggered run', async () => {
    let concurrent = 0;
    let peak = 0;
    let invocations = 0;
    const op = async () => {
      invocations++;
      concurrent++;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 10));
      concurrent--;
    };

    await Promise.all([
      traktWatchedSyncCoordinator.run(1, op),
      traktWatchedSyncCoordinator.run(1, op),
    ]);

    assert.equal(peak, 1);
    assert.equal(
      invocations,
      2,
      'the second caller must run its own operation rather than join the first'
    );
  });

  it('a rejected predecessor does not poison a subsequent run for the same connectionId', async () => {
    let secondRan = false;

    const first = traktWatchedSyncCoordinator.run(2, async () => {
      throw new Error('predecessor failed');
    });
    const second = traktWatchedSyncCoordinator.run(2, async () => {
      secondRan = true;
      return 'ok';
    });

    await assert.rejects(first, /predecessor failed/);
    assert.equal(await second, 'ok');
    assert.equal(secondRan, true);
  });
});

describe('traktWatchedSyncService.syncAll', () => {
  it('one connection failing does not stop the others', async () => {
    const failingConnection = await loadConnection(await seedConnection());
    const activeConnection = await loadConnection(await seedConnection());
    mock.method(traktConnectionRepository, 'findActive', async () => [
      failingConnection,
      activeConnection,
    ]);
    mock.method(
      traktAuthenticatedApiService,
      'withAuthenticatedApi',
      async (userId: number, operation: (api: unknown) => Promise<unknown>) => {
        if (userId === failingConnection.userId) {
          throw new Error('boom');
        }
        return operation(fakeApi);
      }
    );
    const synced: number[] = [];
    mock.method(
      traktWatchedItemRepository,
      'reconcile',
      async (connectionId: number) => {
        synced.push(connectionId);
      }
    );

    await traktWatchedSyncService.syncAll();

    assert.deepEqual(synced, [activeConnection.id]);

    const failedRow = await getRepository(TraktConnection).findOneOrFail({
      where: { id: failingConnection.id },
    });
    assert.equal(failedRow.lastWatchedSyncStatus, 'failed');
  });
});
