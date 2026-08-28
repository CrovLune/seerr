import { getRepository } from '@server/datasource';
import {
  TraktConnection,
  TraktConnectionStatus,
} from '@server/entity/TraktConnection';
import type { TraktWatchedItem } from '@server/entity/TraktWatchedItem';
import type { User } from '@server/entity/User';
import type {
  TraktCardWatchState,
  TraktCardWatchStatusItem,
  TraktCardWatchStatusResponse,
  TraktCardWatcher,
} from '@server/interfaces/api/traktInterfaces';
import { Permission } from '@server/lib/permissions';
import { traktWatchedItemRepository } from '@server/lib/trakt/watchedItemRepository';

type MediaType = 'movie' | 'tv';

/**
 * A stored row means "watched"; its absence means "not started" by construction. Once
 * `watchedEpisodes` exceeds `airedEpisodes` the two numbers describe different episode
 * universes -- evidence the inputs disagree, not evidence of completion -- so that case
 * deliberately falls through to `partial` rather than being treated as caught up.
 */
export const deriveState = (
  row:
    | Pick<TraktWatchedItem, 'mediaType' | 'watchedEpisodes' | 'airedEpisodes'>
    | undefined
): TraktCardWatchState => {
  if (!row) {
    return 'not_started';
  }
  if (row.mediaType === 'movie') {
    return 'complete';
  }
  const aired = row.airedEpisodes ?? 0;
  if (aired > 0 && row.watchedEpisodes === aired) {
    return 'complete';
  }
  return 'partial';
};

/**
 * Turns a household's watched-item snapshot into per-member watch states for a batch of media,
 * for rendering chips on media cards.
 */
class TraktCardWatchStatusService {
  public async getBatch(input: {
    viewer: User;
    items: { mediaType: MediaType; tmdbId: number }[];
  }): Promise<TraktCardWatchStatusResponse> {
    const connections = await this.getVisibleConnections(input.viewer);
    // A connection with no successful sync has no trustworthy data. Rendering it as
    // not-started would be a confident lie on every poster in the library, so it is
    // dropped entirely rather than shown grey.
    const eligible = connections.filter(
      (connection) => connection.lastWatchedSuccessfulSyncAt !== null
    );

    const rows = await traktWatchedItemRepository.findForMedia(
      eligible.map((connection) => connection.id),
      input.items
    );
    const rowsByKey = new Map<string, TraktWatchedItem>();
    for (const row of rows) {
      rowsByKey.set(`${row.connectionId}:${row.mediaType}:${row.tmdbId}`, row);
    }

    const results: TraktCardWatchStatusItem[] = input.items.map((item) => {
      const stateFor = (connection: TraktConnection): TraktCardWatchState =>
        deriveState(
          rowsByKey.get(`${connection.id}:${item.mediaType}:${item.tmdbId}`)
        );

      const watchers: TraktCardWatcher[] = this.orderConnections(
        eligible,
        input.viewer.id,
        stateFor
      ).map((connection) => ({
        userId: connection.userId,
        displayName: this.displayNameFor(connection),
        state: stateFor(connection),
      }));

      const viewerConnection = eligible.find(
        (connection) => connection.userId === input.viewer.id
      );

      return {
        mediaType: item.mediaType,
        tmdbId: item.tmdbId,
        viewerState: viewerConnection ? stateFor(viewerConnection) : null,
        watchers,
        totalWatchers: eligible.length,
      };
    });

    return { results };
  }

  /**
   * Viewer first, then members who watched, then the rest -- so the viewer's own state is
   * never the one hidden behind a `+N` overflow chip.
   */
  private orderConnections(
    connections: TraktConnection[],
    viewerId: number,
    stateFor: (connection: TraktConnection) => TraktCardWatchState
  ): TraktConnection[] {
    const viewer = connections.filter(
      (connection) => connection.userId === viewerId
    );
    const others = connections.filter(
      (connection) => connection.userId !== viewerId
    );
    const watched = others.filter(
      (connection) => stateFor(connection) !== 'not_started'
    );
    const rest = others.filter(
      (connection) => stateFor(connection) === 'not_started'
    );
    return [...viewer, ...watched, ...rest];
  }

  /**
   * Mirrors `TraktWatchStatusService`'s household visibility rule: admins see every active
   * connection, everyone else sees only their own.
   */
  private getVisibleConnections(viewer: User): Promise<TraktConnection[]> {
    const query = getRepository(TraktConnection)
      .createQueryBuilder('connection')
      .innerJoinAndSelect('connection.user', 'user')
      .select([
        'connection.id',
        'connection.userId',
        'connection.lastWatchedSuccessfulSyncAt',
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

  private displayNameFor(connection: TraktConnection): string {
    const user = connection.user;
    return (
      user.displayName ||
      user.username ||
      user.plexUsername ||
      user.jellyfinUsername ||
      'Seerr user'
    );
  }
}

export const traktCardWatchStatusService = new TraktCardWatchStatusService();
