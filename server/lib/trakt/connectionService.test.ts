import TraktAPI from '@server/api/trakt';
import { getRepository } from '@server/datasource';
import {
  TraktConnection,
  TraktConnectionStatus,
} from '@server/entity/TraktConnection';
import {
  TraktOAuthTransaction,
  TraktOAuthTransactionStatus,
} from '@server/entity/TraktOAuthTransaction';
import { User } from '@server/entity/User';
import cacheManager from '@server/lib/cache';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import {
  TraktConflictError,
  TraktConnectionService,
} from './connectionService';

setupTestDb();

const allowedOrigin = 'https://overseerr.pixeltrophies.com';

const users = () => getRepository(User);
const transactions = () => getRepository(TraktOAuthTransaction);
const connections = () => getRepository(TraktConnection);

const admin = () =>
  users().findOneByOrFail({
    email: 'admin@seerr.dev',
  });
const friend = () =>
  users().findOneByOrFail({
    email: 'friend@seerr.dev',
  });

const rawStateFrom = (authorizationUrl: string): string => {
  const state = new URL(authorizationUrl).searchParams.get('state');
  assert.ok(state);
  return state;
};

const mockSuccessfulTrakt = (
  profile: {
    traktUserId: string;
    username: string | null;
    slug: string | null;
    displayName: string | null;
  } = {
    traktUserId: '101',
    username: 'trakt-user',
    slug: 'trakt-user',
    displayName: 'Trakt User',
  }
) => {
  mock.method(TraktAPI.prototype, 'exchangeCode', async () => ({
    accessToken: 'new-access-token',
    refreshToken: 'new-refresh-token',
    expiresAt: new Date('2030-01-01T00:00:00.000Z'),
  }));
  mock.method(TraktAPI.prototype, 'getProfile', async () => profile);
};

beforeEach(() => {
  getSettings().trakt = {
    clientId: 'client-id',
    clientSecret: 'client-secret',
  };
  cacheManager.getCache('trakt-watch-status').flush();
});

afterEach(() => {
  mock.restoreAll();
});

describe('TraktConnectionService', () => {
  it('rejects an origin outside the production allowlist', async () => {
    const actor = await admin();

    await assert.rejects(
      new TraktConnectionService().startAuthorization({
        actorUserId: actor.id,
        targetUserId: actor.id,
        origin: 'https://attacker.invalid',
      }),
      /invalid.*origin/i
    );
    assert.equal(await transactions().count(), 0);
  });

  it('rejects incomplete installation credentials before creating a transaction', async () => {
    const actor = await admin();
    getSettings().trakt = { clientId: ' ', clientSecret: 'client-secret' };

    await assert.rejects(
      new TraktConnectionService().startAuthorization({
        actorUserId: actor.id,
        targetUserId: actor.id,
        origin: allowedOrigin,
      }),
      /not configured/i
    );
    assert.equal(await transactions().count(), 0);
  });

  it('rejects a missing target before creating a transaction', async () => {
    const actor = await admin();

    await assert.rejects(
      new TraktConnectionService().startAuthorization({
        actorUserId: actor.id,
        targetUserId: 999_999,
        origin: allowedOrigin,
      }),
      /target.*missing/i
    );
    assert.equal(await transactions().count(), 0);
  });

  it('stores only the state hash for ten minutes and returns a forced-login URL', async () => {
    const actor = await admin();
    const startedAt = Date.now();
    const result = await new TraktConnectionService().startAuthorization({
      actorUserId: actor.id,
      targetUserId: actor.id,
      origin: allowedOrigin,
    });
    const rawState = rawStateFrom(result.authorizationUrl);
    const row = await transactions().findOneByOrFail({
      id: result.transactionId,
    });

    assert.equal(
      row.stateHash,
      createHash('sha256').update(rawState).digest('hex')
    );
    assert.equal(JSON.stringify(row).includes(rawState), false);
    assert.equal(row.actorUserId, actor.id);
    assert.equal(row.targetUserId, actor.id);
    assert.equal(row.origin, allowedOrigin);
    assert.equal(
      new URL(result.authorizationUrl).searchParams.get('prompt'),
      'login'
    );
    assert.ok(row.expiresAt.getTime() >= startedAt + 599_000);
    assert.ok(row.expiresAt.getTime() <= Date.now() + 601_000);
  });

  it('consumes callback state once and rejects replay, unknown state, and malformed stored origins safely', async () => {
    const actor = await admin();
    const service = new TraktConnectionService();
    const start = await service.startAuthorization({
      actorUserId: actor.id,
      targetUserId: actor.id,
      origin: allowedOrigin,
    });
    const state = rawStateFrom(start.authorizationUrl);
    mockSuccessfulTrakt();

    assert.equal(
      (await service.completeAuthorization({ state, code: 'oauth-code' }))
        .status,
      'succeeded'
    );
    assert.deepEqual(
      await service.completeAuthorization({ state, code: 'oauth-code' }),
      {
        canNotifyOpener: true,
        transactionId: start.transactionId,
        origin: allowedOrigin,
        status: 'failed',
        resultCode: 'state_replayed',
        httpStatus: 400,
      }
    );
    assert.deepEqual(
      await service.completeAuthorization({
        state: 'unknown-state',
        code: 'oauth-code',
      }),
      {
        canNotifyOpener: false,
        status: 'failed',
        resultCode: 'invalid_state',
        httpStatus: 400,
      }
    );

    const malformed = await service.startAuthorization({
      actorUserId: actor.id,
      targetUserId: actor.id,
      origin: allowedOrigin,
    });
    await transactions().update(malformed.transactionId, {
      origin: 'javascript:alert(1)',
    });
    assert.deepEqual(
      await service.completeAuthorization({
        state: rawStateFrom(malformed.authorizationUrl),
        code: 'oauth-code',
      }),
      {
        canNotifyOpener: false,
        status: 'failed',
        resultCode: 'invalid_state',
        httpStatus: 400,
      }
    );
  });

  it('fails expired callback state and atomically expires pending polling', async () => {
    const actor = await admin();
    const service = new TraktConnectionService();
    const callbackStart = await service.startAuthorization({
      actorUserId: actor.id,
      targetUserId: actor.id,
      origin: allowedOrigin,
    });
    await transactions().update(callbackStart.transactionId, {
      expiresAt: new Date(Date.now() - 1),
    });

    assert.equal(
      (
        await service.completeAuthorization({
          state: rawStateFrom(callbackStart.authorizationUrl),
          code: 'oauth-code',
        })
      ).resultCode,
      'state_expired'
    );

    const pollStart = await service.startAuthorization({
      actorUserId: actor.id,
      targetUserId: actor.id,
      origin: allowedOrigin,
    });
    await transactions().update(pollStart.transactionId, {
      expiresAt: new Date(Date.now() - 1),
    });
    assert.deepEqual(
      await service.getTransactionStatus(pollStart.transactionId, actor.id),
      { status: 'failed', resultCode: 'state_expired' }
    );
    const row = await transactions().findOneByOrFail({
      id: pollStart.transactionId,
    });
    assert.equal(row.status, TraktOAuthTransactionStatus.FAILED);
    assert.ok(row.consumedAt);
  });

  it('reconnects the same target and stable Trakt identity', async () => {
    const actor = await admin();
    const existing = await connections().save(
      connections().create({
        userId: actor.id,
        traktUserId: '101',
        username: 'old-name',
        status: TraktConnectionStatus.RECONNECT_REQUIRED,
        tokenVersion: 4,
      })
    );
    const service = new TraktConnectionService();
    const start = await service.startAuthorization({
      actorUserId: actor.id,
      targetUserId: actor.id,
      origin: allowedOrigin,
    });
    mockSuccessfulTrakt();

    const result = await service.completeAuthorization({
      state: rawStateFrom(start.authorizationUrl),
      code: 'oauth-code',
    });

    assert.equal(result.status, 'succeeded');
    assert.equal(await connections().count(), 1);
    const updated = await connections()
      .createQueryBuilder('connection')
      .addSelect(['connection.accessToken', 'connection.refreshToken'])
      .where('connection.id = :id', { id: existing.id })
      .getOneOrFail();
    assert.equal(updated.id, existing.id);
    assert.equal(updated.tokenVersion, 5);
    assert.equal(updated.accessToken, 'new-access-token');
  });

  it('maps target and identity conflicts to their safe 409 codes', async () => {
    const actor = await admin();
    const other = await friend();
    await connections().save(
      connections().create({
        userId: actor.id,
        traktUserId: 'different-id',
        status: TraktConnectionStatus.RECONNECT_REQUIRED,
      })
    );
    const targetService = new TraktConnectionService();
    const targetStart = await targetService.startAuthorization({
      actorUserId: actor.id,
      targetUserId: actor.id,
      origin: allowedOrigin,
    });
    mockSuccessfulTrakt();
    const targetResult = await targetService.completeAuthorization({
      state: rawStateFrom(targetStart.authorizationUrl),
      code: 'oauth-code',
    });
    assert.equal(targetResult.resultCode, 'target_has_different_trakt_account');
    assert.equal(targetResult.httpStatus, 409);

    await connections().clear();
    await connections().save(
      connections().create({
        userId: other.id,
        traktUserId: '101',
        status: TraktConnectionStatus.RECONNECT_REQUIRED,
      })
    );
    const identityStart = await targetService.startAuthorization({
      actorUserId: actor.id,
      targetUserId: actor.id,
      origin: allowedOrigin,
    });
    const identityResult = await targetService.completeAuthorization({
      state: rawStateFrom(identityStart.authorizationUrl),
      code: 'oauth-code',
    });
    assert.equal(
      identityResult.resultCode,
      'trakt_account_owned_by_another_user'
    );
    assert.equal(identityResult.httpStatus, 409);
  });

  it('stores a successful connection and clears the OAuth result atomically', async () => {
    const actor = await admin();
    const target = await friend();
    const service = new TraktConnectionService();
    const start = await service.startAuthorization({
      actorUserId: actor.id,
      targetUserId: target.id,
      origin: allowedOrigin,
    });
    mockSuccessfulTrakt();

    const before = Date.now();
    const result = await service.completeAuthorization({
      state: rawStateFrom(start.authorizationUrl),
      code: 'oauth-code',
    });
    const connection = await connections()
      .createQueryBuilder('connection')
      .addSelect(['connection.accessToken', 'connection.refreshToken'])
      .where('connection.userId = :targetId', { targetId: target.id })
      .getOneOrFail();
    const transaction = await transactions().findOneByOrFail({
      id: start.transactionId,
    });

    assert.equal(result.status, 'succeeded');
    assert.equal(connection.traktUserId, '101');
    assert.equal(connection.username, 'trakt-user');
    assert.equal(connection.slug, 'trakt-user');
    assert.equal(connection.displayName, 'Trakt User');
    assert.equal(connection.status, TraktConnectionStatus.ACTIVE);
    assert.equal(connection.connectedByUserId, actor.id);
    assert.equal(connection.tokenVersion, 1);
    assert.equal(connection.accessToken, 'new-access-token');
    assert.equal(connection.refreshToken, 'new-refresh-token');
    assert.equal(
      connection.expiresAt?.toISOString(),
      '2030-01-01T00:00:00.000Z'
    );
    assert.ok((connection.lastValidatedAt?.getTime() ?? 0) >= before);
    assert.equal(transaction.status, TraktOAuthTransactionStatus.SUCCEEDED);
    assert.equal(transaction.resultCode, null);
    assert.ok(transaction.consumedAt);
  });

  it('marks a denied callback failed without creating a connection', async () => {
    const actor = await admin();
    const service = new TraktConnectionService();
    const start = await service.startAuthorization({
      actorUserId: actor.id,
      targetUserId: actor.id,
      origin: allowedOrigin,
    });

    const result = await service.completeAuthorization({
      state: rawStateFrom(start.authorizationUrl),
      error: 'access_denied',
    });

    assert.equal(result.resultCode, 'access_denied');
    assert.equal(await connections().count(), 0);
    const row = await transactions().findOneByOrFail({
      id: start.transactionId,
    });
    assert.equal(row.status, TraktOAuthTransactionStatus.FAILED);
    assert.ok(row.consumedAt);
  });

  it('exposes processing as pending and interrupts it after two minutes', async () => {
    const actor = await admin();
    const service = new TraktConnectionService();
    const start = await service.startAuthorization({
      actorUserId: actor.id,
      targetUserId: actor.id,
      origin: allowedOrigin,
    });
    await transactions().update(start.transactionId, {
      status: TraktOAuthTransactionStatus.PROCESSING,
      expiresAt: new Date(Date.now() + 120_000),
    });
    assert.deepEqual(
      await service.getTransactionStatus(start.transactionId, actor.id),
      { status: 'pending', resultCode: null }
    );

    await transactions().update(start.transactionId, {
      expiresAt: new Date(Date.now() - 1),
    });
    assert.deepEqual(
      await service.getTransactionStatus(start.transactionId, actor.id),
      { status: 'failed', resultCode: 'oauth_interrupted' }
    );
  });

  it('shows transaction status only to the actor that started it', async () => {
    const actor = await admin();
    const other = await friend();
    const service = new TraktConnectionService();
    const start = await service.startAuthorization({
      actorUserId: actor.id,
      targetUserId: actor.id,
      origin: allowedOrigin,
    });

    await assert.rejects(
      service.getTransactionStatus(start.transactionId, other.id),
      /transaction.*not found/i
    );
  });

  it('deletes terminal and long-expired unconsumed transactions after 24 hours', async () => {
    const actor = await admin();
    const now = new Date('2026-07-31T12:00:00.000Z');
    const old = new Date(now.getTime() - 24 * 60 * 60 * 1000 - 1);
    const recent = new Date(now.getTime() - 24 * 60 * 60 * 1000 + 1);
    const make = (
      status: TraktOAuthTransactionStatus,
      expiresAt: Date,
      consumedAt: Date | null
    ) =>
      transactions().create({
        id: randomUUID(),
        stateHash: createHash('sha256').update(randomUUID()).digest('hex'),
        actorUserId: actor.id,
        targetUserId: actor.id,
        origin: allowedOrigin,
        status,
        expiresAt,
        consumedAt,
      });
    await transactions().save([
      make(TraktOAuthTransactionStatus.PENDING, old, null),
      make(TraktOAuthTransactionStatus.PROCESSING, old, null),
      make(TraktOAuthTransactionStatus.SUCCEEDED, now, old),
      make(TraktOAuthTransactionStatus.FAILED, now, old),
      make(TraktOAuthTransactionStatus.PENDING, recent, null),
      make(TraktOAuthTransactionStatus.FAILED, now, recent),
    ]);

    assert.equal(
      await new TraktConnectionService().deleteExpiredTransactions(now),
      4
    );
    assert.equal(await transactions().count(), 2);
  });

  it('converges simultaneous callbacks on one canonical connection', async () => {
    const actor = await admin();
    const target = await friend();
    const service = new TraktConnectionService();
    const [adminStart, selfStart] = await Promise.all([
      service.startAuthorization({
        actorUserId: actor.id,
        targetUserId: target.id,
        origin: allowedOrigin,
      }),
      service.startAuthorization({
        actorUserId: target.id,
        targetUserId: target.id,
        origin: allowedOrigin,
      }),
    ]);
    mockSuccessfulTrakt();

    const results = await Promise.all([
      service.completeAuthorization({
        state: rawStateFrom(adminStart.authorizationUrl),
        code: 'admin-code',
      }),
      service.completeAuthorization({
        state: rawStateFrom(selfStart.authorizationUrl),
        code: 'self-code',
      }),
    ]);

    assert.deepEqual(
      results.map((result) => result.status),
      ['succeeded', 'succeeded']
    );
    assert.equal(await connections().count(), 1);
    assert.equal(
      (await connections().findOneByOrFail({ userId: target.id })).tokenVersion,
      2
    );
  });

  it('emits safe structured completion logs without OAuth secrets', async () => {
    const actor = await admin();
    const service = new TraktConnectionService();
    const start = await service.startAuthorization({
      actorUserId: actor.id,
      targetUserId: actor.id,
      origin: allowedOrigin,
    });
    const rawState = rawStateFrom(start.authorizationUrl);
    const entries: unknown[] = [];
    const listener = (entry: unknown) => entries.push(entry);
    const wasSilent = logger.silent;
    logger.silent = false;
    logger.on('data', listener);
    mockSuccessfulTrakt();

    try {
      await service.completeAuthorization({
        state: rawState,
        code: 'super-secret-oauth-code',
      });
    } finally {
      logger.off('data', listener);
      logger.silent = wasSilent;
    }

    const serialized = JSON.stringify(entries);
    assert.match(serialized, /oauth_complete/);
    assert.match(serialized, /connectionId/);
    assert.match(serialized, /targetUserId/);
    assert.match(serialized, /httpClass/);
    assert.match(serialized, /succeeded/);
    assert.doesNotMatch(serialized, /super-secret-oauth-code/);
    assert.doesNotMatch(serialized, new RegExp(rawState));
    assert.doesNotMatch(
      serialized,
      /new-access-token|new-refresh-token|client-secret/
    );
  });

  it('fails safely when actor or target disappears before callback', async () => {
    const actor = await admin();
    const target = await friend();
    const service = new TraktConnectionService();
    const targetStart = await service.startAuthorization({
      actorUserId: actor.id,
      targetUserId: target.id,
      origin: allowedOrigin,
    });
    await users().remove(target);
    const result = await service.completeAuthorization({
      state: rawStateFrom(targetStart.authorizationUrl),
      code: 'oauth-code',
    });
    assert.equal(result.resultCode, 'target_missing');
    assert.equal(await connections().count(), 0);

    const actorStart = await service.startAuthorization({
      actorUserId: actor.id,
      targetUserId: actor.id,
      origin: allowedOrigin,
    });
    await users().remove(actor);
    assert.deepEqual(
      await service.completeAuthorization({
        state: rawStateFrom(actorStart.authorizationUrl),
        code: 'oauth-code',
      }),
      {
        canNotifyOpener: false,
        status: 'failed',
        resultCode: 'invalid_state',
        httpStatus: 400,
      }
    );
  });

  it('rechecks ADMIN permission before a cross-user callback', async () => {
    const actor = await admin();
    const target = await friend();
    const service = new TraktConnectionService();
    const start = await service.startAuthorization({
      actorUserId: actor.id,
      targetUserId: target.id,
      origin: allowedOrigin,
    });
    actor.permissions = Permission.REQUEST;
    await users().save(actor);
    mockSuccessfulTrakt();

    const result = await service.completeAuthorization({
      state: rawStateFrom(start.authorizationUrl),
      code: 'oauth-code',
    });

    assert.equal(result.resultCode, 'actor_not_authorized');
    assert.equal(await connections().count(), 0);
  });

  it('invalidates only the reconnected connection watch-status keys', async () => {
    const actor = await admin();
    const existing = await connections().save(
      connections().create({
        userId: actor.id,
        traktUserId: '101',
        status: TraktConnectionStatus.RECONNECT_REQUIRED,
      })
    );
    const cache = cacheManager.getCache('trakt-watch-status').data;
    cache.set(`${existing.id}:movie:1`, true);
    cache.set(`${existing.id}:tv:2`, true);
    cache.set(`${existing.id + 1}:movie:1`, true);
    const service = new TraktConnectionService();
    const start = await service.startAuthorization({
      actorUserId: actor.id,
      targetUserId: actor.id,
      origin: allowedOrigin,
    });
    mockSuccessfulTrakt();

    await service.completeAuthorization({
      state: rawStateFrom(start.authorizationUrl),
      code: 'oauth-code',
    });

    assert.equal(cache.has(`${existing.id}:movie:1`), false);
    assert.equal(cache.has(`${existing.id}:tv:2`), false);
    assert.equal(cache.has(`${existing.id + 1}:movie:1`), true);
  });

  it('does not expose raw database constraint errors from unique races', () => {
    assert.equal(
      new TraktConflictError('target_has_different_trakt_account').message,
      'target_has_different_trakt_account'
    );
  });
});
