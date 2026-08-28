import type {
  TraktCardWatchStatusResponse,
  TraktSeasonWatchStatusResponse,
  TraktWatchStatusResponse,
} from '@server/interfaces/api/traktInterfaces';
import { traktCardWatchStatusService } from '@server/lib/trakt/cardWatchStatusService';
import { TraktConnectionService } from '@server/lib/trakt/connectionService';
import type { TraktMediaType } from '@server/lib/trakt/connectionVisibility';
import { TraktWatchStatusService } from '@server/lib/trakt/watchStatusService';
import { Router } from 'express';

const traktRoutes = Router();

const MAX_BATCH_ITEMS = 100;

const parsePositiveTmdbId = (value: string): number | null => {
  const tmdbId = Number(value);
  return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(tmdbId)
    ? tmdbId
    : null;
};

const isValidBatchItem = (
  value: unknown
): value is { mediaType: TraktMediaType; tmdbId: number } => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { mediaType, tmdbId } = value as Record<string, unknown>;
  return (
    (mediaType === 'movie' || mediaType === 'tv') &&
    typeof tmdbId === 'number' &&
    Number.isSafeInteger(tmdbId) &&
    tmdbId > 0
  );
};

traktRoutes.get<
  { mediaType: string; tmdbId: string },
  TraktWatchStatusResponse
>('/watchstatus/:mediaType/:tmdbId', async (req, res, next) => {
  if (!req.user) {
    return next({ status: 401, message: 'Authentication required.' });
  }
  const { mediaType, tmdbId: tmdbIdParam } = req.params;
  const tmdbId = parsePositiveTmdbId(tmdbIdParam);
  if ((mediaType !== 'movie' && mediaType !== 'tv') || tmdbId === null) {
    return next({ status: 400, message: 'Invalid watch status path.' });
  }

  try {
    const status = await new TraktWatchStatusService().getWatchStatus({
      viewer: req.user,
      mediaType,
      tmdbId,
    });
    return res.status(200).json(status);
  } catch {
    return next({
      status: 500,
      message: 'Unable to retrieve Trakt watch status.',
    });
  }
});

traktRoutes.get<{ tmdbId: string }, TraktSeasonWatchStatusResponse>(
  '/watchstatus/tv/:tmdbId/seasons',
  async (req, res, next) => {
    if (!req.user) {
      return next({ status: 401, message: 'Authentication required.' });
    }
    const { tmdbId: tmdbIdParam } = req.params;
    const tmdbId = parsePositiveTmdbId(tmdbIdParam);
    if (tmdbId === null) {
      return next({ status: 400, message: 'Invalid watch status path.' });
    }

    try {
      const status = await new TraktWatchStatusService().getSeasonWatchStatus({
        viewer: req.user,
        tmdbId,
      });
      return res.status(200).json(status);
    } catch {
      return next({
        status: 500,
        message: 'Unable to retrieve Trakt watch status.',
      });
    }
  }
);

traktRoutes.post<never, TraktCardWatchStatusResponse>(
  '/watchstatus/batch',
  async (req, res, next) => {
    if (!req.user) {
      return next({ status: 401, message: 'Authentication required.' });
    }
    const items = req.body?.items;
    if (
      !Array.isArray(items) ||
      items.length > MAX_BATCH_ITEMS ||
      !items.every(isValidBatchItem)
    ) {
      return next({ status: 400, message: 'Invalid watch status batch.' });
    }

    try {
      const response = await traktCardWatchStatusService.getBatch({
        viewer: req.user,
        items: items as { mediaType: TraktMediaType; tmdbId: number }[],
      });
      return res.status(200).json(response);
    } catch {
      return next({
        status: 500,
        message: 'Unable to resolve Trakt watch status.',
      });
    }
  }
);

traktRoutes.get('/oauth/:transactionId/status', async (req, res, next) => {
  if (!req.user) {
    return next({ status: 401, message: 'Authentication required.' });
  }
  try {
    const status = await new TraktConnectionService().getTransactionStatus(
      req.params.transactionId,
      req.user.id
    );
    if (
      status.status === 'failed' &&
      (status.resultCode === 'target_has_different_trakt_account' ||
        status.resultCode === 'trakt_account_owned_by_another_user')
    ) {
      return res.status(409).json({
        message: 'Trakt account conflict.',
        code: status.resultCode,
      });
    }
    return res.status(200).json(status);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Unable to retrieve Trakt OAuth status.';
    if (/not found/i.test(message)) {
      return next({
        status: 404,
        message: 'Trakt OAuth transaction not found.',
      });
    }
    return next({
      status: 500,
      message: 'Unable to retrieve Trakt OAuth status.',
    });
  }
});

export default traktRoutes;
