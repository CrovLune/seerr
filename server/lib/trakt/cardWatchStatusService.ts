import type { TraktConnection } from '@server/entity/TraktConnection';
import type { TraktWatchedItem } from '@server/entity/TraktWatchedItem';
import type { User } from '@server/entity/User';
import type {
  TraktCardWatchState,
  TraktCardWatchStatusItem,
  TraktCardWatchStatusResponse,
  TraktCardWatcher,
} from '@server/interfaces/api/traktInterfaces';
import {
  displayNameFor,
  getVisibleConnections,
  type TraktMediaType as MediaType,
} from '@server/lib/trakt/connectionVisibility';
import { traktWatchedItemRepository } from '@server/lib/trakt/watchedItemRepository';

const VISIBLE_CONNECTION_FIELDS = [
  'connection.id',
  'connection.userId',
  'connection.lastWatchedSuccessfulSyncAt',
  'user.id',
  'user.username',
  'user.plexUsername',
  'user.jellyfinUsername',
];

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
    const connections = await getVisibleConnections(
      input.viewer,
      VISIBLE_CONNECTION_FIELDS
    );
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
        displayName: displayNameFor(connection),
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
}

export const traktCardWatchStatusService = new TraktCardWatchStatusService();
