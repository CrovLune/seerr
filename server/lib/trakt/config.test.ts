import Settings from '@server/lib/settings';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  TRAKT_CALLBACK_URL,
  getAllowedTraktOrigins,
  getSafeTraktSettings,
  isTraktConfigured,
} from './config';

describe('Trakt configuration', () => {
  it('uses one canonical public callback', () => {
    assert.equal(
      TRAKT_CALLBACK_URL,
      'https://overseerr.pixeltrophies.com/api/v1/auth/trakt/callback'
    );
  });

  it('allows only the two production origins', () => {
    assert.deepEqual(getAllowedTraktOrigins(), [
      'https://overseerr.pixeltrophies.com',
      'https://overseerr.local.pixeltrophies.com',
    ]);
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
