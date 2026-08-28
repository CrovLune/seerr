import type { TraktWatchedMovie, TraktWatchedShow } from '@server/api/trakt';

export interface WatchedSnapshotItem {
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  watchedEpisodes: number;
  airedEpisodes: number | null;
  lastWatchedAt: Date | null;
}

/**
 * Raised when a watched item cannot be identified. A repository downstream deletes every row
 * absent from the snapshot, so silently dropping an unidentifiable item would read as "never
 * watched" instead of "unknown" — the whole sync is abandoned rather than risk that.
 */
export class IncompleteSnapshotError extends Error {}

const toDate = (value: string | null): Date | null =>
  value ? new Date(value) : null;

/**
 * Translates Trakt's watched-library payload into the shape the repository persists. Counts
 * distinct episodes rather than summing `plays`, since rewatches would otherwise inflate a show
 * past its aired count and falsely read as complete.
 */
export const buildWatchedSnapshot = (
  movies: TraktWatchedMovie[],
  shows: TraktWatchedShow[]
): WatchedSnapshotItem[] => {
  const items: WatchedSnapshotItem[] = [];

  for (const movie of movies) {
    if (movie.tmdbId === null) {
      throw new IncompleteSnapshotError('Watched movie is missing a TMDB id');
    }
    items.push({
      mediaType: 'movie',
      tmdbId: movie.tmdbId,
      watchedEpisodes: 1,
      airedEpisodes: null,
      lastWatchedAt: toDate(movie.lastWatchedAt),
    });
  }

  for (const show of shows) {
    if (show.tmdbId === null) {
      throw new IncompleteSnapshotError('Watched show is missing a TMDB id');
    }
    const resetAt = toDate(show.resetAt);
    const counted = new Set<string>();
    let latest: Date | null = null;

    for (const episode of show.episodes) {
      if (episode.season === 0 || episode.plays <= 0) {
        continue;
      }
      const watchedAt = toDate(episode.lastWatchedAt);
      if (resetAt && watchedAt && watchedAt < resetAt) {
        continue;
      }
      counted.add(`${episode.season}:${episode.episode}`);
      if (watchedAt && (!latest || watchedAt > latest)) {
        latest = watchedAt;
      }
    }

    items.push({
      mediaType: 'tv',
      tmdbId: show.tmdbId,
      watchedEpisodes: counted.size,
      airedEpisodes: show.airedEpisodes,
      lastWatchedAt: latest,
    });
  }

  return items;
};
