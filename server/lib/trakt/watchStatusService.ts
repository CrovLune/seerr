import { getRepository } from '@server/datasource';
import {
  TraktConnection,
  TraktConnectionStatus,
} from '@server/entity/TraktConnection';
import type { User } from '@server/entity/User';
import type {
  TraktWatchStatusItem,
  TraktWatchStatusResponse,
} from '@server/interfaces/api/traktInterfaces';
import cacheManager from '@server/lib/cache';
import { Permission } from '@server/lib/permissions';
import { TraktConnectionService } from '@server/lib/trakt/connectionService';

const LOOKUP_TIMEOUT_MS = 10_000;
const MAPPING_HIT_TTL_SECONDS = 86_400;
const MAPPING_MISS_TTL_SECONDS = 3_600;
const WATCH_STATUS_TTL_SECONDS = 300;
const CONNECTION_CONCURRENCY = 4;

type MediaType = 'movie' | 'tv';

type CachedMapping = { kind: 'hit'; traktId: number } | { kind: 'miss' };

interface CachedWatchResult {
  watched: boolean;
  watchedAt: string | null;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await worker(items[index]);
      }
    }
  );
  await Promise.all(runners);
  return results;
}

export class TraktWatchStatusService {
  public async getWatchStatus(input: {
    viewer: User;
    mediaType: MediaType;
    tmdbId: number;
  }): Promise<TraktWatchStatusResponse> {
    const connections = await this.getVisibleConnections(input.viewer);
    const response = {
      mediaType: input.mediaType,
      tmdbId: input.tmdbId,
    };

    if (connections.length === 0) {
      return { ...response, items: [] };
    }

    const mapping = await this.getMapping(
      connections[0].userId,
      input.mediaType,
      input.tmdbId
    );

    if (mapping === 'temporarily_unavailable') {
      return {
        ...response,
        items: connections.map((connection) =>
          this.toItem(connection, {
            watched: false,
            watchedAt: null,
            status: 'temporarily_unavailable',
          })
        ),
      };
    }

    if (mapping.kind === 'miss') {
      return {
        ...response,
        items: connections.map((connection) =>
          this.toItem(connection, {
            watched: false,
            watchedAt: null,
            status: 'ok',
          })
        ),
      };
    }

    const items = await mapWithConcurrency(
      connections,
      CONNECTION_CONCURRENCY,
      (connection) =>
        this.getConnectionStatus(
          connection,
          input.mediaType,
          input.tmdbId,
          mapping.traktId
        )
    );
    return { ...response, items };
  }

  private getVisibleConnections(viewer: User): Promise<TraktConnection[]> {
    const query = getRepository(TraktConnection)
      .createQueryBuilder('connection')
      .innerJoinAndSelect('connection.user', 'user')
      .select([
        'connection.id',
        'connection.userId',
        'connection.username',
        'connection.tokenVersion',
        'user.id',
        'user.username',
        'user.plexUsername',
        'user.jellyfinUsername',
      ])
      .where('connection.status = :status', {
        status: TraktConnectionStatus.ACTIVE,
      })
      .orderBy('connection.userId', 'ASC');

    if (!viewer.hasPermission(Permission.ADMIN)) {
      query.andWhere('connection.userId = :viewerId', {
        viewerId: viewer.id,
      });
    }

    return query.getMany();
  }

  private async getMapping(
    userId: number,
    mediaType: MediaType,
    tmdbId: number
  ): Promise<CachedMapping | 'temporarily_unavailable'> {
    const cache = cacheManager.getCache('trakt-media').data;
    const key = `${mediaType}:${tmdbId}`;
    const cached = cache.get<CachedMapping>(key);
    if (cached) {
      return cached;
    }

    try {
      const traktId = await new TraktConnectionService().withAuthenticatedApi(
        userId,
        (api) =>
          api.findByTmdbId(
            mediaType,
            tmdbId,
            AbortSignal.timeout(LOOKUP_TIMEOUT_MS)
          )
      );
      const mapping: CachedMapping =
        traktId === null ? { kind: 'miss' } : { kind: 'hit', traktId };
      cache.set(
        key,
        mapping,
        mapping.kind === 'hit'
          ? MAPPING_HIT_TTL_SECONDS
          : MAPPING_MISS_TTL_SECONDS
      );
      return mapping;
    } catch {
      return 'temporarily_unavailable';
    }
  }

  private async getConnectionStatus(
    connection: TraktConnection,
    mediaType: MediaType,
    tmdbId: number,
    traktId: number
  ): Promise<TraktWatchStatusItem> {
    const cache = cacheManager.getCache('trakt-watch-status').data;
    const key = `connection:${connection.id}:version:${connection.tokenVersion}:${mediaType}:${tmdbId}`;
    const cached = cache.get<CachedWatchResult>(key);
    if (cached) {
      return this.toItem(connection, { ...cached, status: 'ok' });
    }

    try {
      const history = await new TraktConnectionService().withAuthenticatedApi(
        connection.userId,
        (api) =>
          api.getWatchHistory(
            mediaType,
            traktId,
            AbortSignal.timeout(LOOKUP_TIMEOUT_MS)
          )
      );
      const result: CachedWatchResult = {
        watched: history !== null,
        watchedAt: history?.watchedAt ?? null,
      };
      cache.set(key, result, WATCH_STATUS_TTL_SECONDS);
      return this.toItem(connection, { ...result, status: 'ok' });
    } catch {
      return this.toItem(connection, {
        watched: false,
        watchedAt: null,
        status: 'temporarily_unavailable',
      });
    }
  }

  private toItem(
    connection: TraktConnection,
    status: Pick<TraktWatchStatusItem, 'watched' | 'watchedAt' | 'status'>
  ): TraktWatchStatusItem {
    const user = connection.user;
    const displayName =
      user.displayName ||
      user.username ||
      user.plexUsername ||
      user.jellyfinUsername ||
      'Seerr user';
    return {
      userId: connection.userId,
      displayName,
      traktUsername: connection.username ?? null,
      ...status,
    };
  }
}
