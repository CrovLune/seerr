import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';

import axios from 'axios';

import type { TraktWatchedMovie, TraktWatchedShow } from '@server/api/trakt';
import TraktAPI from '@server/api/trakt';

import {
  buildWatchedSnapshot,
  IncompleteSnapshotError,
} from './watchedLibrarySync';

type RawWatchedShowFixture = { show?: { title?: string } }[];

const show = (over: Partial<TraktWatchedShow> = {}): TraktWatchedShow => ({
  tmdbId: 10,
  airedEpisodes: 10,
  resetAt: null,
  episodes: [],
  ...over,
});

const ep = (
  season: number,
  episode: number,
  over: Partial<TraktWatchedShow['episodes'][number]> = {}
): TraktWatchedShow['episodes'][number] => ({
  season,
  episode,
  plays: 1,
  lastWatchedAt: '2026-03-01T00:00:00.000Z',
  ...over,
});

describe('buildWatchedSnapshot', () => {
  it('counts distinct episodes rather than summing plays', () => {
    const [item] = buildWatchedSnapshot(
      [],
      [show({ episodes: [ep(1, 1, { plays: 5 }), ep(1, 2, { plays: 3 })] })]
    );

    assert.equal(item!.watchedEpisodes, 2);
  });

  it('excludes season 0 so specials cannot fake completion', () => {
    const episodes = [
      ep(0, 1),
      ...Array.from({ length: 9 }, (_, i) => ep(1, i + 1)),
    ];
    const [item] = buildWatchedSnapshot([], [show({ episodes })]);

    assert.equal(item!.watchedEpisodes, 9);
    assert.ok(item!.watchedEpisodes < item!.airedEpisodes!);
  });

  it('ignores episodes watched before reset_at', () => {
    const [item] = buildWatchedSnapshot(
      [],
      [
        show({
          resetAt: '2026-06-01T00:00:00.000Z',
          episodes: [
            ep(1, 1, { lastWatchedAt: '2026-01-01T00:00:00.000Z' }),
            ep(1, 2, { lastWatchedAt: '2026-07-01T00:00:00.000Z' }),
          ],
        }),
      ]
    );

    assert.equal(item!.watchedEpisodes, 1);
  });

  it('keeps episodes when reset_at is null', () => {
    const [item] = buildWatchedSnapshot(
      [],
      [show({ episodes: [ep(1, 1), ep(1, 2)] })]
    );

    assert.equal(item!.watchedEpisodes, 2);
  });

  it('drops episodes with zero plays', () => {
    const [item] = buildWatchedSnapshot(
      [],
      [show({ episodes: [ep(1, 1, { plays: 0 })] })]
    );

    assert.equal(item!.watchedEpisodes, 0);
  });

  it('maps a watched movie to one episode and no aired count', () => {
    const movie: TraktWatchedMovie = {
      tmdbId: 7,
      lastWatchedAt: '2026-04-04T00:00:00.000Z',
    };
    const [item] = buildWatchedSnapshot([movie], []);

    assert.equal(item!.mediaType, 'movie');
    assert.equal(item!.watchedEpisodes, 1);
    assert.equal(item!.airedEpisodes, null);
  });

  it('throws rather than silently skipping a movie with no TMDB id', () => {
    assert.throws(
      () => buildWatchedSnapshot([{ tmdbId: null, lastWatchedAt: null }], []),
      IncompleteSnapshotError
    );
  });

  it('throws rather than silently skipping a show with no TMDB id', () => {
    assert.throws(
      () => buildWatchedSnapshot([], [show({ tmdbId: null })]),
      IncompleteSnapshotError
    );
  });

  it('uses the latest watched-episode timestamp for a show', () => {
    const [item] = buildWatchedSnapshot(
      [],
      [
        show({
          episodes: [
            ep(1, 1, { lastWatchedAt: '2026-01-01T00:00:00.000Z' }),
            ep(1, 2, { lastWatchedAt: '2026-05-05T00:00:00.000Z' }),
          ],
        }),
      ]
    );

    assert.deepEqual(item!.lastWatchedAt, new Date('2026-05-05T00:00:00.000Z'));
  });

  it('collapses two shows sharing a TMDB id into one row, keeping the higher watched count', () => {
    const snapshot = buildWatchedSnapshot(
      [],
      [
        show({ tmdbId: 99, episodes: [ep(1, 1)] }),
        show({ tmdbId: 99, episodes: [ep(1, 1), ep(1, 2), ep(1, 3)] }),
      ]
    );

    assert.equal(snapshot.length, 1);
    assert.equal(snapshot[0]!.watchedEpisodes, 3);
  });

  it('collapses two movies sharing a TMDB id into one row', () => {
    const snapshot = buildWatchedSnapshot(
      [
        { tmdbId: 42, lastWatchedAt: '2026-01-01T00:00:00.000Z' },
        { tmdbId: 42, lastWatchedAt: '2026-02-02T00:00:00.000Z' },
      ],
      []
    );

    assert.equal(snapshot.length, 1);
  });

  it('parses the captured live response without losing items', async () => {
    const raw = JSON.parse(
      readFileSync(
        join(__dirname, '__fixtures__/watched-shows-progress-page1.json'),
        'utf8'
      )
    ) as RawWatchedShowFixture;
    assert.ok(
      raw.length > 0,
      'fixture is empty — recapture it, do not skip this test'
    );

    const apiHttp = axios.create();
    mock.method(apiHttp, 'get', async () => ({
      data: raw,
      headers: { 'x-pagination-page-count': '1' },
    }));
    const api = new TraktAPI(
      'client-id',
      'client-secret',
      'access-token',
      axios.create(),
      apiHttp
    );

    const shows = await api.getWatchedShows();
    const snapshot = buildWatchedSnapshot([], shows);

    assert.equal(snapshot.length, raw.length);

    const watchedEpisodesByTitle = new Map(
      raw.map((entry, index) => [
        entry.show?.title,
        snapshot[index]!.watchedEpisodes,
      ])
    );

    assert.equal(watchedEpisodesByTitle.get('Rick and Morty'), 81);
    assert.equal(watchedEpisodesByTitle.get('Invincible'), 32);
    assert.equal(watchedEpisodesByTitle.get('Twisted Metal'), 20);
    assert.equal(watchedEpisodesByTitle.get('CyberSlav'), 1);
  });
});
