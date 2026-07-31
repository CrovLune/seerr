import { TraktConnectionService } from '@server/lib/trakt/connectionService';
import { Router } from 'express';
import { randomBytes } from 'node:crypto';

const traktCallbackRoutes = Router();

const staticErrorPage =
  '<!doctype html><meta charset="utf-8"><title>Trakt connection</title><p>Trakt connection could not be completed.</p>';

traktCallbackRoutes.get('/callback', async (req, res) => {
  res.type('html');
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Frame-Options', 'DENY');
  res.set('Cross-Origin-Opener-Policy', 'unsafe-none');

  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const code = typeof req.query.code === 'string' ? req.query.code : undefined;
  const error =
    typeof req.query.error === 'string' ? req.query.error : undefined;
  if (!state || (!code && !error)) {
    res.set(
      'Content-Security-Policy',
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    );
    return res.status(400).send(staticErrorPage);
  }

  try {
    const outcome = await new TraktConnectionService().completeAuthorization({
      state,
      code,
      error,
    });
    if (!outcome.canNotifyOpener) {
      res.set(
        'Content-Security-Policy',
        "default-src 'none'; base-uri 'none'; frame-ancestors 'none'"
      );
      return res.status(outcome.httpStatus).send(staticErrorPage);
    }

    const nonce = randomBytes(18).toString('base64url');
    const message = JSON.stringify({
      type: 'trakt-oauth-result',
      transactionId: outcome.transactionId,
      status: outcome.status,
    });
    const targetOrigin = JSON.stringify(outcome.origin);
    res.set(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`
    );
    return res
      .status(outcome.httpStatus)
      .send(
        '<!doctype html><meta charset="utf-8"><title>Trakt connection</title>' +
          `<script nonce="${nonce}">window.opener?.postMessage(${message},${targetOrigin});window.close();</script>`
      );
  } catch {
    res.set(
      'Content-Security-Policy',
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    );
    return res.status(500).send(staticErrorPage);
  }
});

export default traktCallbackRoutes;
