import { useTraktCardWatchStatus } from '@app/components/TraktWatchChips/WatchedStatusProvider';
import defineMessages from '@app/utils/defineMessages';
import type {
  TraktCardWatchState,
  TraktCardWatcher,
} from '@server/interfaces/api/traktInterfaces';
import { useIntl } from 'react-intl';

const MAX_VISIBLE_WATCHERS = 4;

const messages = defineMessages('components.TraktWatchChips', {
  caughtUp: 'Caught up',
  partiallyWatched: 'Partially watched',
  notStarted: 'Not started',
  moreWatchers: '{count} more',
});

interface TraktWatchChipsProps {
  mediaType: 'movie' | 'tv';
  tmdbId: number;
}

// Distinct from the yellow-500 used by MediaStatus.PENDING in StatusBadgeMini: that badge
// sits top-right, these chips sit centred, and the two hues are chosen to never be confused.
const fillFor = (state: TraktCardWatchState) =>
  state === 'complete'
    ? 'bg-green-600 text-white'
    : state === 'partial'
      ? 'bg-amber-500 text-white'
      : 'bg-gray-600 text-gray-300';

const messageFor = (state: TraktCardWatchState) =>
  state === 'complete'
    ? messages.caughtUp
    : state === 'partial'
      ? messages.partiallyWatched
      : messages.notStarted;

const TraktWatchChips = ({ mediaType, tmdbId }: TraktWatchChipsProps) => {
  const intl = useIntl();
  const item = useTraktCardWatchStatus(mediaType, tmdbId);

  if (!item || item.watchers.length === 0) {
    return null;
  }

  const visible = item.watchers.slice(0, MAX_VISIBLE_WATCHERS);
  const overflow = item.totalWatchers - MAX_VISIBLE_WATCHERS;

  const renderChip = (watcher: TraktCardWatcher, index: number) => (
    <span
      key={watcher.userId}
      data-testid="trakt-watch-chip"
      aria-label={`${watcher.displayName}: ${intl.formatMessage(
        messageFor(watcher.state)
      )}`}
      className={`flex h-6 w-6 items-center justify-center rounded-full border-2 border-gray-800 text-xs font-semibold ${fillFor(
        watcher.state
      )} ${index === 0 ? '' : '-ml-[7px]'}`}
    >
      {watcher.displayName.charAt(0).toUpperCase()}
    </span>
  );

  return (
    <div className="inline-flex items-center rounded-full bg-gray-950/70 p-1">
      {visible.map(renderChip)}
      {overflow > 0 && (
        <span
          data-testid="trakt-watch-chip-overflow"
          aria-label={intl.formatMessage(messages.moreWatchers, {
            count: overflow,
          })}
          className="-ml-[7px] flex h-6 w-6 items-center justify-center rounded-full border-2 border-gray-800 bg-gray-800 text-xs font-semibold text-blue-300"
        >
          +{overflow}
        </span>
      )}
    </div>
  );
};

export default TraktWatchChips;
