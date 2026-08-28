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
   * cannot abort the sync for the rest of the household.
   */
  public async syncAll(): Promise<void> {
    const connections = await traktConnectionRepository.findActive();
    await Promise.allSettled(
      connections.map((connection) => this.syncConnection(connection))
    );
  }
}

export const traktWatchedSyncService = new TraktWatchedSyncService();
