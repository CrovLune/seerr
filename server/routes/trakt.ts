import { TraktConnectionService } from '@server/lib/trakt/connectionService';
import { Router } from 'express';

const traktRoutes = Router();

traktRoutes.get('/oauth/:transactionId/status', async (req, res, next) => {
  if (!req.user) {
    return next({ status: 401, message: 'Authentication required.' });
  }
  try {
    const status = await new TraktConnectionService().getTransactionStatus(
      req.params.transactionId,
      req.user.id
    );
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
