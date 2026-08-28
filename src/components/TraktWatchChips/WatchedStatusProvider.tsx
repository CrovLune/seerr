import type {
  TraktCardWatchStatusItem,
  TraktCardWatchStatusResponse,
} from '@server/interfaces/api/traktInterfaces';
import axios from 'axios';
import type { MutableRefObject, ReactNode } from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

// Matches the server's own MAX_BATCH_ITEMS cap in server/routes/trakt.ts.
const CHUNK_SIZE = 100;
const DEBOUNCE_MS = 50;

interface TraktWatchedStatusContextValue {
  register: (mediaType: string, tmdbId: number) => void;
  results: Map<string, TraktCardWatchStatusItem>;
}

export const TraktWatchedStatusContext =
  createContext<TraktWatchedStatusContextValue>({
    register: () => undefined,
    results: new Map(),
  });

export const TraktWatchedStatusProvider = ({
  children,
}: {
  children: ReactNode;
}) => {
  const [results, setResults] = useState<Map<string, TraktCardWatchStatusItem>>(
    new Map()
  );
  const pending = useRef(new Set<string>());
  const timer: MutableRefObject<ReturnType<typeof setTimeout> | undefined> =
    useRef(undefined);

  const flush = useCallback(async () => {
    const keys = [...pending.current];
    pending.current.clear();
    if (keys.length === 0) return;

    const items = keys.map((key) => {
      const [mediaType, tmdbId] = key.split(':');
      return { mediaType, tmdbId: Number(tmdbId) };
    });

    for (let i = 0; i < items.length; i += CHUNK_SIZE) {
      const chunk = items.slice(i, i + CHUNK_SIZE);
      try {
        const { data } = await axios.post<TraktCardWatchStatusResponse>(
          '/api/v1/trakt/watchstatus/batch',
          { items: chunk }
        );
        setResults((prev) => {
          const next = new Map(prev);
          for (const result of data.results) {
            next.set(`${result.mediaType}:${result.tmdbId}`, result);
          }
          return next;
        });
      } catch {
        // Swallowed: cards render without chips rather than a per-grid toast.
      }
    }
  }, []);

  const register = useCallback(
    (mediaType: string, tmdbId: number) => {
      if (mediaType !== 'movie' && mediaType !== 'tv') return;
      const key = `${mediaType}:${tmdbId}`;
      if (results.has(key) || pending.current.has(key)) return;
      pending.current.add(key);
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, DEBOUNCE_MS);
    },
    [flush, results]
  );

  return (
    <TraktWatchedStatusContext.Provider value={{ register, results }}>
      {children}
    </TraktWatchedStatusContext.Provider>
  );
};

export const useTraktCardWatchStatus = (
  mediaType: string,
  tmdbId: number
): TraktCardWatchStatusItem | undefined => {
  const { register, results } = useContext(TraktWatchedStatusContext);

  useEffect(() => {
    register(mediaType, tmdbId);
  }, [register, mediaType, tmdbId]);

  return results.get(`${mediaType}:${tmdbId}`);
};
