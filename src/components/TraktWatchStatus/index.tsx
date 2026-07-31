import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import type { TraktWatchStatusResponse } from '@server/interfaces/api/traktInterfaces';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.TraktWatchStatus', {
  title: 'Trakt Watch Status',
  loading: 'Loading Trakt watch status',
  watched: 'Watched',
  notWatched: 'Not watched',
  temporarilyUnavailable: 'Temporarily unavailable',
});

interface TraktWatchStatusProps {
  mediaType: 'movie' | 'tv';
  tmdbId: number;
}

const TraktWatchStatus = ({ mediaType, tmdbId }: TraktWatchStatusProps) => {
  const intl = useIntl();
  const { user } = useUser();
  const { data, error } = useSWR<TraktWatchStatusResponse>(
    user ? `/api/v1/trakt/watchstatus/${mediaType}/${tmdbId}` : null
  );

  if (!user || error || data?.items.length === 0) {
    return null;
  }

  if (!data) {
    return (
      <div
        className="media-fact flex-col gap-1"
        aria-label={intl.formatMessage(messages.loading)}
      >
        <span>{intl.formatMessage(messages.title)}</span>
        <span className="h-8 w-full animate-pulse rounded bg-gray-700" />
      </div>
    );
  }

  return (
    <div className="media-fact flex-col gap-1" data-testid="trakt-watch-status">
      <span>{intl.formatMessage(messages.title)}</span>
      <div className="media-fact-value flex w-full flex-col gap-2">
        {data.items.map((item) => (
          <div
            className="flex w-full items-start justify-between gap-3"
            data-testid="trakt-watch-status-item"
            key={item.userId}
          >
            <span className="min-w-0">
              <span className="block truncate">{item.displayName}</span>
              {item.traktUsername ? (
                <span className="block truncate text-xs text-gray-400">
                  @{item.traktUsername}
                </span>
              ) : null}
            </span>
            <span className="shrink-0 text-right">
              {item.status === 'temporarily_unavailable' ? (
                intl.formatMessage(messages.temporarilyUnavailable)
              ) : item.watched ? (
                <>
                  <span className="block">
                    {intl.formatMessage(messages.watched)}
                  </span>
                  {item.watchedAt ? (
                    <span className="block text-xs text-gray-400">
                      {intl.formatDate(item.watchedAt, {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                      })}
                    </span>
                  ) : null}
                </>
              ) : (
                intl.formatMessage(messages.notWatched)
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default TraktWatchStatus;
