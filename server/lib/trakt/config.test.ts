import Settings from '@server/lib/settings';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getAllowedTraktOrigins,
  getSafeTraktSettings,
  getTraktCallbackUrl,
  isAllowedTraktOrigin,
  isTraktConfigured,
} from './config';

const withEnv = (
  env: { NODE_ENV?: string; TRAKT_DEV_ORIGIN?: string },
  run: () => void
) => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    TRAKT_DEV_ORIGIN: process.env.TRAKT_DEV_ORIGIN,
  };

  Object.assign(process.env, env);
  if (!('TRAKT_DEV_ORIGIN' in env)) {
    delete process.env.TRAKT_DEV_ORIGIN;
  }

  try {
    run();
  } finally {
    Object.assign(process.env, previous);
    if (previous.TRAKT_DEV_ORIGIN === undefined) {
      delete process.env.TRAKT_DEV_ORIGIN;
    }
  }
};

describe('Trakt configuration', () => {
  it('uses one canonical public callback', () => {
    assert.equal(
      getTraktCallbackUrl(),
      'https://overseerr.pixeltrophies.com/api/v1/auth/trakt/callback'
    );
  });

  it('allows only the two production origins', () => {
    assert.deepEqual(getAllowedTraktOrigins(), [
      'https://overseerr.pixeltrophies.com',
      'https://overseerr.local.pixeltrophies.com',
    ]);
  });

  it('admits a configured development origin and returns the OAuth round-trip to it', () => {
    withEnv(
      { NODE_ENV: 'development', TRAKT_DEV_ORIGIN: 'http://localhost:5055/' },
      () => {
        assert.deepEqual(getAllowedTraktOrigins(), [
          'https://overseerr.pixeltrophies.com',
          'https://overseerr.local.pixeltrophies.com',
          'http://localhost:5055',
        ]);
        assert.equal(isAllowedTraktOrigin('http://localhost:5055'), true);
        assert.equal(
          getTraktCallbackUrl(),
          'http://localhost:5055/api/v1/auth/trakt/callback'
        );
      }
    );
  });

  it('keeps the production allowlist and callback when a development origin is set in production', () => {
    withEnv(
      { NODE_ENV: 'production', TRAKT_DEV_ORIGIN: 'http://localhost:5055' },
      () => {
        assert.deepEqual(getAllowedTraktOrigins(), [
          'https://overseerr.pixeltrophies.com',
          'https://overseerr.local.pixeltrophies.com',
        ]);
        assert.equal(isAllowedTraktOrigin('http://localhost:5055'), false);
        assert.equal(
          getTraktCallbackUrl(),
          'https://overseerr.pixeltrophies.com/api/v1/auth/trakt/callback'
        );
      }
    );
  });

  it('ignores a blank development origin outside production', () => {
    withEnv({ NODE_ENV: 'development', TRAKT_DEV_ORIGIN: '   ' }, () => {
      assert.deepEqual(getAllowedTraktOrigins(), [
        'https://overseerr.pixeltrophies.com',
        'https://overseerr.local.pixeltrophies.com',
      ]);
      assert.equal(
        getTraktCallbackUrl(),
        'https://overseerr.pixeltrophies.com/api/v1/auth/trakt/callback'
      );
    });
  });

  it('redacts the secret and reports only whether it is configured', () => {
    assert.deepEqual(
      getSafeTraktSettings({
        clientId: 'client-id',
        clientSecret: 'secret-value',
      }),
      {
        clientId: 'client-id',
        clientSecretConfigured: true,
        callbackUrl:
          'https://overseerr.pixeltrophies.com/api/v1/auth/trakt/callback',
      }
    );
  });

  it('requires a normalized client ID and nonempty secret to be configured', () => {
    assert.equal(
      isTraktConfigured({ clientId: ' client-id ', clientSecret: 'secret' }),
      true
    );
    assert.equal(
      isTraktConfigured({ clientId: '   ', clientSecret: 'secret' }),
      false
    );
    assert.equal(
      isTraktConfigured({ clientId: 'client-id', clientSecret: '' }),
      false
    );
  });

  it('retains an omitted secret, replaces a supplied secret, and rejects an empty one', () => {
    const settings = new Settings();
    settings.trakt = {
      clientId: 'client-id',
      clientSecret: 'existing-secret',
    };

    settings.trakt = { clientId: 'updated-client-id' };
    assert.deepEqual(settings.trakt, {
      clientId: 'updated-client-id',
      clientSecret: 'existing-secret',
    });

    settings.trakt = {
      clientId: 'updated-client-id',
      clientSecret: 'replacement-secret',
    };
    assert.equal(settings.trakt.clientSecret, 'replacement-secret');

    assert.throws(() => {
      settings.trakt = {
        clientId: 'updated-client-id',
        clientSecret: '',
      };
    }, /client secret must not be empty/i);
  });
});
