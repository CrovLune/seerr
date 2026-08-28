import type { TraktConnection } from '@server/entity/TraktConnection';
import { traktAuthenticatedApiService } from '@server/lib/trakt/authenticatedApiService';
import { traktConnectionRepository } from '@server/lib/trakt/connectionRepository';
import { traktWatchedItemRepository } from '@server/lib/trakt/watchedItemRepository';
import { buildWatchedSnapshot } from '@server/lib/trakt/watchedLibrarySync';
import { traktWatchedSyncCoordinator } from '@server/lib/trakt/watchedSyncCoordinator';
import logger from '@server/logger';

class TraktWatchedSyncService {
  /**
   * `withAuthenticatedApi` replays its callback once after a 401, so only the two idempotent
   * Trakt reads live inside it. `buildWatchedSnapshot` and `reconcile` run after it settles,
   * which keeps them from running twice on a mid-sync token refresh.
   */
  public async syncConnection(connection: TraktConnection): Promise<void> {
    await traktWatchedSyncCoordinator.run(connection.id, async () => {
      try {
        const { movies, shows } =
          await traktAuthenticatedApiService.withAuthenticatedApi(
            connection.userId,
            async (api) => ({
              movies: await api.getWatchedMovies(),
              shows: await api.getWatchedShows(),
            })
          );

        const snapshot = buildWatchedSnapshot(movies, shows);
        await traktWatchedItemRepository.reconcile(connection.id, snapshot);
      } catch (error) {
        await traktConnectionRepository.markWatchedSyncFailed(connection.id);
        logger.warn('Trakt watched sync failed', {
          label: 'Trakt',
          connectionId: connection.id,
          errorClass:
            error instanceof Error ? error.constructor.name : 'Unknown',
        });
      }
    });
  }

  /**
   * Isolates each connection's failure with `Promise.allSettled` so one broken connection
   * cannot abort the sync for the rest of the household. Also swallows a failure to even list
   * active connections: the scheduler calls this fire-and-forget, and Node's
   * `--unhandled-rejections=throw` default would otherwise crash the process on a transient
   * database error during a cron tick.
   */
  public async syncAll(): Promise<void> {
    let connections: TraktConnection[];
    try {
      connections = await traktConnectionRepository.findActive();
    } catch (error) {
      logger.warn('Trakt watched sync could not list active connections', {
        label: 'Trakt',
        errorClass: error instanceof Error ? error.constructor.name : 'Unknown',
      });
      return;
    }

    await Promise.allSettled(
      connections.map((connection) => this.syncConnection(connection))
    );
  }
}

export const traktWatchedSyncService = new TraktWatchedSyncService();
