import type { TraktWatchStatusResponse } from '@server/interfaces/api/traktInterfaces';
import { TraktConnectionService } from '@server/lib/trakt/connectionService';
import { TraktWatchStatusService } from '@server/lib/trakt/watchStatusService';
import { Router } from 'express';

const traktRoutes = Router();

traktRoutes.get<
  { mediaType: string; tmdbId: string },
  TraktWatchStatusResponse
>('/watchstatus/:mediaType/:tmdbId', async (req, res, next) => {
  if (!req.user) {
    return next({ status: 401, message: 'Authentication required.' });
  }
  const { mediaType, tmdbId: tmdbIdParam } = req.params;
  const tmdbId = Number(tmdbIdParam);
  if (
    (mediaType !== 'movie' && mediaType !== 'tv') ||
    !/^[1-9]\d*$/.test(tmdbIdParam) ||
    !Number.isSafeInteger(tmdbId)
  ) {
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
