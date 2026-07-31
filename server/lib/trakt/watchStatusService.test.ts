import type TraktAPI from '@server/api/trakt';
import { TraktApiError } from '@server/api/trakt';
import { getRepository } from '@server/datasource';
import {
  TraktConnection,
  TraktConnectionStatus,
} from '@server/entity/TraktConnection';
import { User } from '@server/entity/User';
import cacheManager from '@server/lib/cache';
import { TraktConnectionService } from '@server/lib/trakt/connectionService';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { TraktWatchStatusService } from './watchStatusService';

setupTestDb();

const users = () => getRepository(User);
const connections = () => getRepository(TraktConnection);

const admin = () => users().findOneByOrFail({ email: 'admin@seerr.dev' });
const friend = () => users().findOneByOrFail({ email: 'friend@seerr.dev' });

async function saveConnection(
  user: User,
  input: {
    status?: TraktConnectionStatus;
    tokenVersion?: number;
    username?: string;
  } = {}
): Promise<TraktConnection> {
  return connections().save(
    connections().create({
      userId: user.id,
      traktUserId: `trakt-${user.id}`,
      username: input.username ?? `trakt-user-${user.id}`,
      status: input.status ?? TraktConnectionStatus.ACTIVE,
      accessToken: 'secret-access-token',
      refreshToken: 'secret-refresh-token',
      expiresAt: new Date(Date.now() + 60_000),
      tokenVersion: input.tokenVersion ?? 1,
    })
  );
}

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

function mockAuthenticatedApi(
  api: Pick<TraktAPI, 'findByTmdbId' | 'getWatchHistory'>
) {
  return mock.method(
    TraktConnectionService.prototype,
    'withAuthenticatedApi',
    async (
      _userId: number,
      operation: (authenticatedApi: TraktAPI) => Promise<unknown>
    ) => operation(api as TraktAPI)
  );
}

beforeEach(() => {
  cacheManager.getCache('trakt-media').flush();
  cacheManager.getCache('trakt-watch-status').flush();
});

afterEach(() => {
  mock.restoreAll();
});

describe('TraktWatchStatusService', () => {
  it('caches a successful TMDB mapping for 24 hours', async () => {
    const viewer = await friend();
    await saveConnection(viewer);
    let mappings = 0;
    mockAuthenticatedApi({
      findByTmdbId: async () => {
        mappings += 1;
        return 777;
      },
      getWatchHistory: async () => null,
    });
    const service = new TraktWatchStatusService();

    await service.getWatchStatus({ viewer, mediaType: 'movie', tmdbId: 42 });
    await service.getWatchStatus({ viewer, mediaType: 'movie', tmdbId: 42 });

    assert.equal(mappings, 1);
    const ttl = cacheManager.getCache('trakt-media').data.getTtl('movie:42');
    assert.ok(ttl);
    assert.ok(ttl - Date.now() > 86_390_000);
    assert.ok(ttl - Date.now() <= 86_400_000);
  });

  it('caches a typed mapping miss for one hour and skips history', async () => {
    const viewer = await friend();
    await saveConnection(viewer);
    let mappings = 0;
    let histories = 0;
    mockAuthenticatedApi({
      findByTmdbId: async () => {
        mappings += 1;
        return null;
      },
      getWatchHistory: async () => {
        histories += 1;
        return null;
      },
    });
    const service = new TraktWatchStatusService();

    const first = await service.getWatchStatus({
      viewer,
      mediaType: 'tv',
      tmdbId: 55,
    });
    const second = await service.getWatchStatus({
      viewer,
      mediaType: 'tv',
      tmdbId: 55,
    });

    assert.equal(mappings, 1);
    assert.equal(histories, 0);
    assert.equal(first.items[0].watched, false);
    assert.equal(first.items[0].status, 'ok');
    assert.deepEqual(second, first);
    const ttl = cacheManager.getCache('trakt-media').data.getTtl('tv:55');
    assert.ok(ttl);
    assert.ok(ttl - Date.now() > 3_590_000);
    assert.ok(ttl - Date.now() <= 3_600_000);
  });

  it('caches each connection result for five minutes with the exact versioned key', async () => {
    const viewer = await friend();
    const connection = await saveConnection(viewer, { tokenVersion: 7 });
    let histories = 0;
    mockAuthenticatedApi({
      findByTmdbId: async () => 808,
      getWatchHistory: async () => {
        histories += 1;
        return { watchedAt: '2026-07-31T10:00:00.000Z' };
      },
    });
    const service = new TraktWatchStatusService();

    await service.getWatchStatus({ viewer, mediaType: 'movie', tmdbId: 80 });
    await service.getWatchStatus({ viewer, mediaType: 'movie', tmdbId: 80 });

    assert.equal(histories, 1);
    const key = `connection:${connection.id}:version:7:movie:80`;
    const ttl = cacheManager.getCache('trakt-watch-status').data.getTtl(key);
    assert.ok(ttl);
    assert.ok(ttl - Date.now() > 290_000);
    assert.ok(ttl - Date.now() <= 300_000);
  });

  it('runs no more than four connection history lookups concurrently', async () => {
    const viewer = await admin();
    const household = [viewer];
    for (let index = 0; index < 6; index += 1) {
      household.push(await saveUser(index));
    }
    for (const user of household) {
      await saveConnection(user);
    }
    let active = 0;
    let maximum = 0;
    mockAuthenticatedApi({
      findByTmdbId: async () => 900,
      getWatchHistory: async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise<void>((resolve) => setImmediate(resolve));
        active -= 1;
        return null;
      },
    });

    const result = await new TraktWatchStatusService().getWatchStatus({
      viewer,
      mediaType: 'movie',
      tmdbId: 90,
    });

    assert.equal(result.items.length, 7);
    assert.equal(maximum, 4);
  });

  it('gives every mapping and history network lookup a ten-second deadline', async () => {
    const viewer = await friend();
    await saveConnection(viewer);
    const deadlines: number[] = [];
    mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
      deadlines.push(milliseconds);
      return new AbortController().signal;
    });
    mockAuthenticatedApi({
      findByTmdbId: async (_mediaType, _tmdbId, signal) => {
        assert.ok(signal);
        return 404;
      },
      getWatchHistory: async (_mediaType, _traktId, signal) => {
        assert.ok(signal);
        return null;
      },
    });

    await new TraktWatchStatusService().getWatchStatus({
      viewer,
      mediaType: 'tv',
      tmdbId: 40,
    });

    assert.deepEqual(deadlines, [10_000, 10_000]);
  });

  it('shows all active household connections to ADMIN and only the viewer connection to ordinary users', async () => {
    const adminUser = await admin();
    const friendUser = await friend();
    adminUser.username = 'Seerr Admin';
    friendUser.username = 'Seerr Friend';
    await users().save([adminUser, friendUser]);
    await saveConnection(adminUser);
    await saveConnection(friendUser);
    mockAuthenticatedApi({
      findByTmdbId: async () => 12,
      getWatchHistory: async () => null,
    });
    const service = new TraktWatchStatusService();

    const household = await service.getWatchStatus({
      viewer: adminUser,
      mediaType: 'movie',
      tmdbId: 12,
    });
    const personal = await service.getWatchStatus({
      viewer: friendUser,
      mediaType: 'movie',
      tmdbId: 13,
    });

    assert.deepEqual(
      household.items.map(({ userId, displayName }) => ({
        userId,
        displayName,
      })),
      [
        { userId: adminUser.id, displayName: 'Seerr Admin' },
        { userId: friendUser.id, displayName: 'Seerr Friend' },
      ]
    );
    assert.deepEqual(
      personal.items.map((item) => item.userId),
      [friendUser.id]
    );
    assert.equal(JSON.stringify(household).includes('@seerr.dev'), false);
    assert.equal(JSON.stringify(household).includes('secret-'), false);
  });

  it('excludes reconnect-required rows and returns an empty list when no active row is visible', async () => {
    const adminUser = await admin();
    const friendUser = await friend();
    await saveConnection(adminUser, {
      status: TraktConnectionStatus.RECONNECT_REQUIRED,
    });
    await saveConnection(friendUser, {
      status: TraktConnectionStatus.RECONNECT_REQUIRED,
    });
    const authenticated = mockAuthenticatedApi({
      findByTmdbId: async () => 1,
      getWatchHistory: async () => null,
    });

    const result = await new TraktWatchStatusService().getWatchStatus({
      viewer: adminUser,
      mediaType: 'movie',
      tmdbId: 1,
    });

    assert.deepEqual(result, { mediaType: 'movie', tmdbId: 1, items: [] });
    assert.equal(authenticated.mock.callCount(), 0);
  });

  it('returns per-connection failures and rate limits as uncached partial results', async () => {
    const viewer = await admin();
    const other = await friend();
    await saveConnection(viewer);
    await saveConnection(other);
    const calls = new Map<number, number>();
    mock.method(
      TraktConnectionService.prototype,
      'withAuthenticatedApi',
      async (
        userId: number,
        operation: (authenticatedApi: TraktAPI) => Promise<unknown>
      ) => {
        calls.set(userId, (calls.get(userId) ?? 0) + 1);
        if (calls.size === 1 && calls.get(userId) === 1) {
          return operation({
            findByTmdbId: async () => 33,
          } as unknown as TraktAPI);
        }
        if (userId === other.id) {
          throw new TraktApiError('limited', 429, 'RATE_LIMITED');
        }
        return operation({
          getWatchHistory: async () => ({
            watchedAt: '2026-07-30T12:00:00.000Z',
          }),
        } as unknown as TraktAPI);
      }
    );
    const service = new TraktWatchStatusService();

    const first = await service.getWatchStatus({
      viewer,
      mediaType: 'movie',
      tmdbId: 33,
    });
    const second = await service.getWatchStatus({
      viewer,
      mediaType: 'movie',
      tmdbId: 33,
    });

    assert.equal(first.items[0].status, 'ok');
    assert.equal(first.items[0].watched, true);
    assert.equal(first.items[1].status, 'temporarily_unavailable');
    assert.equal(first.items[1].watched, false);
    assert.equal(calls.get(viewer.id), 2);
    assert.equal(calls.get(other.id), 2);
    assert.deepEqual(second.items, first.items);
  });

  it('returns a temporary shared mapping failure for every visible connection and does not cache it', async () => {
    const viewer = await admin();
    const other = await friend();
    await saveConnection(viewer);
    await saveConnection(other);
    let mappings = 0;
    mockAuthenticatedApi({
      findByTmdbId: async () => {
        mappings += 1;
        throw new TraktApiError('offline', 503, 'UPSTREAM_ERROR');
      },
      getWatchHistory: async () => {
        assert.fail('history must not be queried when mapping fails');
      },
    });
    const service = new TraktWatchStatusService();

    const first = await service.getWatchStatus({
      viewer,
      mediaType: 'tv',
      tmdbId: 66,
    });
    const second = await service.getWatchStatus({
      viewer,
      mediaType: 'tv',
      tmdbId: 66,
    });

    assert.equal(mappings, 2);
    assert.deepEqual(
      first.items.map(({ watched, watchedAt, status }) => ({
        watched,
        watchedAt,
        status,
      })),
      [
        { watched: false, watchedAt: null, status: 'temporarily_unavailable' },
        { watched: false, watchedAt: null, status: 'temporarily_unavailable' },
      ]
    );
    assert.deepEqual(second, first);
    assert.equal(cacheManager.getCache('trakt-media').data.has('tv:66'), false);
  });

  it('passes movie and TV through to the exact history lookup types', async () => {
    const viewer = await friend();
    await saveConnection(viewer);
    const mappingTypes: string[] = [];
    const historyTypes: string[] = [];
    mockAuthenticatedApi({
      findByTmdbId: async (mediaType) => {
        mappingTypes.push(mediaType);
        return mediaType === 'movie' ? 1 : 2;
      },
      getWatchHistory: async (mediaType) => {
        historyTypes.push(mediaType);
        return null;
      },
    });
    const service = new TraktWatchStatusService();

    await service.getWatchStatus({ viewer, mediaType: 'movie', tmdbId: 1 });
    await service.getWatchStatus({ viewer, mediaType: 'tv', tmdbId: 2 });

    assert.deepEqual(mappingTypes, ['movie', 'tv']);
    assert.deepEqual(historyTypes, ['movie', 'tv']);
  });

  it('does not select hidden token columns while loading visible connections', async () => {
    const viewer = await friend();
    await saveConnection(viewer);
    mockAuthenticatedApi({
      findByTmdbId: async () => 5,
      getWatchHistory: async () => null,
    });
    const queries: string[] = [];
    const dataSource = connections().manager.connection;
    mock.method(dataSource.logger, 'logQuery', (query: string) => {
      queries.push(query);
    });

    await new TraktWatchStatusService().getWatchStatus({
      viewer,
      mediaType: 'movie',
      tmdbId: 5,
    });

    const visibleQuery = queries.find((query) =>
      query.includes('FROM "trakt_connection" "connection"')
    );
    assert.ok(visibleQuery);
    assert.equal(visibleQuery.includes('accessToken'), false);
    assert.equal(visibleQuery.includes('refreshToken'), false);
  });
});
