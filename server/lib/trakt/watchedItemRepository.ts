import { getRepository } from '@server/datasource';
import { TraktConnection } from '@server/entity/TraktConnection';
import { TraktWatchedItem } from '@server/entity/TraktWatchedItem';
import type { WatchedSnapshotItem } from '@server/lib/trakt/watchedLibrarySync';
import { In } from 'typeorm';

/**
 * TypeORM's array-form `upsert` emits one multi-row statement per call. 500 rows x 5 columns
 * stays well inside SQLite's bound-variable limit while keeping a ~1700-row sync to a handful of
 * round trips instead of one per row.
 */
const UPSERT_CHUNK_SIZE = 500;

const chunk = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

class TraktWatchedItemRepository {
  /**
   * Replaces a connection's watched-item snapshot atomically: upsert, delete-absent, and the
   * success stamp all happen in one transaction. Rows exist only for watched titles, so a
   * partially-applied snapshot — or one a concurrent reader observes mid-write — would read as a
   * false "never watched" for whatever hasn't landed yet. Callers must only pass a snapshot they
   * know to be complete.
   */
  public async reconcile(
    connectionId: number,
    items: WatchedSnapshotItem[]
  ): Promise<void> {
    await getRepository(TraktWatchedItem).manager.transaction(
      async (manager) => {
        const keep = new Set(
          items.map((item) => `${item.mediaType}:${item.tmdbId}`)
        );
        const existing = await manager.find(TraktWatchedItem, {
          where: { connectionId },
        });
        const stale = existing.filter(
          (row) => !keep.has(`${row.mediaType}:${row.tmdbId}`)
        );
        if (stale.length > 0) {
          await manager.delete(TraktWatchedItem, {
            id: In(stale.map((row) => row.id)),
          });
        }

        for (const batch of chunk(items, UPSERT_CHUNK_SIZE)) {
          await manager.upsert(
            TraktWatchedItem,
            batch.map((item) => ({ connectionId, ...item })),
            ['connectionId', 'mediaType', 'tmdbId']
          );
        }

        await manager.update(
          TraktConnection,
          { id: connectionId },
          {
            lastWatchedSuccessfulSyncAt: new Date(),
            lastWatchedSyncStatus: 'ok',
          }
        );
      }
    );
  }

  /**
   * Looks up stored watched rows across connections for a batch of media keys. A returned row only
   * guarantees its (mediaType, tmdbId) matched one of `keys` and its connectionId was in
   * `connectionIds` — callers pair rows back to a specific connection themselves.
   */
  public async findForMedia(
    connectionIds: number[],
    keys: { mediaType: 'movie' | 'tv'; tmdbId: number }[]
  ): Promise<TraktWatchedItem[]> {
    if (connectionIds.length === 0 || keys.length === 0) {
      return [];
    }
    return getRepository(TraktWatchedItem).find({
      where: keys.map((key) => ({
        mediaType: key.mediaType,
        tmdbId: key.tmdbId,
        connectionId: In(connectionIds),
      })),
    });
  }
}

export const traktWatchedItemRepository = new TraktWatchedItemRepository();
