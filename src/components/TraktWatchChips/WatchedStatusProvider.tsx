import { useUser } from '@app/hooks/useUser';
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
  useMemo,
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
  const { user } = useUser();
  const [results, setResults] = useState<Map<string, TraktCardWatchStatusItem>>(
    new Map()
  );
  // Mirrors `results` so `register`'s identity doesn't churn on every chunk resolution.
  const resultsRef = useRef(results);
  const pending = useRef(new Set<string>());
  const timer: MutableRefObject<ReturnType<typeof setTimeout> | undefined> =
    useRef(undefined);
  const viewerId = useRef(user?.id);
  // Bumped on every viewer switch so a response for a since-abandoned viewer is dropped
  // instead of being merged into the next viewer's cache.
  const generation = useRef(0);

  useEffect(() => {
    if (viewerId.current === user?.id) return;
    viewerId.current = user?.id;
    generation.current += 1;
    clearTimeout(timer.current);
    timer.current = undefined;
    pending.current.clear();
    resultsRef.current = new Map();
    setResults(new Map());
  }, [user?.id]);

  const flush = useCallback(async () => {
    const generationAtFlush = generation.current;
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
        if (generation.current !== generationAtFlush) continue;
        setResults((prev) => {
          const next = new Map(prev);
          for (const result of data.results) {
            next.set(`${result.mediaType}:${result.tmdbId}`, result);
          }
          resultsRef.current = next;
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
      if (resultsRef.current.has(key) || pending.current.has(key)) return;
      pending.current.add(key);
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, DEBOUNCE_MS);
    },
    [flush]
  );

  const value = useMemo(() => ({ register, results }), [register, results]);

  return (
    <TraktWatchedStatusContext.Provider value={value}>
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
