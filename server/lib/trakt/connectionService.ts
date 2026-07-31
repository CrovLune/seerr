import TraktAPI, {
  type TraktProfile,
  type TraktTokenSet,
} from '@server/api/trakt';
import dataSource, { getRepository } from '@server/datasource';
import {
  TraktConnection,
  TraktConnectionStatus,
} from '@server/entity/TraktConnection';
import {
  TraktOAuthTransaction,
  TraktOAuthTransactionStatus,
} from '@server/entity/TraktOAuthTransaction';
import { User } from '@server/entity/User';
import type {
  TraktAllowedOrigin,
  TraktAuthorizationResponse,
  TraktOAuthStatusResponse,
  TraktSafeResultCode,
} from '@server/interfaces/api/traktInterfaces';
import cacheManager from '@server/lib/cache';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import {
  isAllowedTraktOrigin,
  isTraktConfigured,
} from '@server/lib/trakt/config';
import { traktConfigurationMutex } from '@server/lib/trakt/configurationMutex';
import logger from '@server/logger';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  In,
  IsNull,
  LessThanOrEqual,
  MoreThan,
  QueryFailedError,
  type EntityManager,
} from 'typeorm';

const AUTHORIZATION_LIFETIME_MS = 10 * 60 * 1000;
const PROCESSING_LIFETIME_MS = 2 * 60 * 1000;
const RETENTION_MS = 24 * 60 * 60 * 1000;

const safeResultCodes = new Set<TraktSafeResultCode>([
  'access_denied',
  'actor_not_authorized',
  'client_id_changed',
  'confirm_reconnect_all_required',
  'invalid_state',
  'oauth_interrupted',
  'state_expired',
  'state_replayed',
  'target_has_different_trakt_account',
  'target_missing',
  'token_exchange_failed',
  'trakt_account_owned_by_another_user',
  'trakt_application_not_configured',
]);

export class TraktConflictError extends Error {
  public constructor(
    public readonly code:
      | 'target_has_different_trakt_account'
      | 'trakt_account_owned_by_another_user'
  ) {
    super(code);
    this.name = 'TraktConflictError';
  }
}

export type TraktAuthorizationCompletion =
  | {
      canNotifyOpener: true;
      transactionId: string;
      origin: TraktAllowedOrigin;
      status: 'succeeded' | 'failed';
      resultCode: TraktSafeResultCode | null;
      httpStatus: 200 | 400 | 409;
    }
  | {
      canNotifyOpener: false;
      status: 'failed';
      resultCode: 'invalid_state';
      httpStatus: 400;
    };

type NotifiableCompletion = Extract<
  TraktAuthorizationCompletion,
  { canNotifyOpener: true }
>;

interface PersistedCompletion {
  connectionId: number;
}

class TerminalTransactionError extends Error {
  public constructor(public readonly resultCode: TraktSafeResultCode) {
    super(resultCode);
  }
}

export class TraktConnectionService {
  public startAuthorization(input: {
    actorUserId: number;
    targetUserId: number;
    origin: string;
  }): Promise<TraktAuthorizationResponse> {
    return traktConfigurationMutex.run(async () => {
      if (!isAllowedTraktOrigin(input.origin)) {
        throw new Error('Invalid Trakt callback origin');
      }

      const settings = getSettings().trakt;
      if (!isTraktConfigured(settings)) {
        throw new Error('Trakt application is not configured');
      }

      const userRepo = getRepository(User);
      const [actor, target] = await Promise.all([
        userRepo.findOneBy({ id: input.actorUserId }),
        userRepo.findOneBy({ id: input.targetUserId }),
      ]);
      if (!actor) {
        throw new Error('Trakt authorization actor is missing');
      }
      if (!target) {
        throw new Error('Trakt authorization target is missing');
      }
      if (actor.id !== target.id && !actor.hasPermission(Permission.ADMIN)) {
        throw new Error('Trakt authorization actor is not authorized');
      }

      const rawState = randomBytes(32).toString('base64url');
      const now = new Date();
      const expiresAt = new Date(now.getTime() + AUTHORIZATION_LIFETIME_MS);
      const transaction = getRepository(TraktOAuthTransaction).create({
        id: randomUUID(),
        stateHash: this.hashState(rawState),
        actorUserId: actor.id,
        targetUserId: target.id,
        origin: input.origin,
        status: TraktOAuthTransactionStatus.PENDING,
        resultCode: null,
        expiresAt,
        consumedAt: null,
      });
      await getRepository(TraktOAuthTransaction).save(transaction);

      const api = new TraktAPI(settings.clientId.trim(), settings.clientSecret);
      return {
        transactionId: transaction.id,
        authorizationUrl: api.buildAuthorizationUrl(rawState),
        callbackOrigin: input.origin,
        expiresAt: expiresAt.toISOString(),
      };
    });
  }

  public async completeAuthorization(input: {
    state: string;
    code?: string;
    error?: string;
  }): Promise<TraktAuthorizationCompletion> {
    const claimed = await traktConfigurationMutex.run(() =>
      this.claimTransaction(input.state)
    );
    if (!claimed) {
      return this.invalidState();
    }
    if ('completion' in claimed) {
      return claimed.completion;
    }

    const transaction = claimed.transaction;
    if (!isAllowedTraktOrigin(transaction.origin)) {
      await traktConfigurationMutex.run(() =>
        this.failProcessingTransaction(transaction.id, 'invalid_state')
      );
      return this.invalidState();
    }
    const callbackOrigin = transaction.origin;

    const completionFor = (
      resultCode: TraktSafeResultCode | null,
      httpStatus: 200 | 400 | 409
    ): NotifiableCompletion => ({
      canNotifyOpener: true,
      transactionId: transaction.id,
      origin: callbackOrigin,
      status: resultCode === null ? 'succeeded' : 'failed',
      resultCode,
      httpStatus,
    });

    const authorizationFailure = await this.validateAuthorization(transaction);
    if (authorizationFailure) {
      const resultCode = await traktConfigurationMutex.run(() =>
        this.failProcessingTransaction(transaction.id, authorizationFailure)
      );
      const completion = completionFor(
        resultCode,
        this.httpStatusFor(resultCode)
      );
      this.logCompletion(completion, transaction.targetUserId ?? null, null);
      return completion;
    }

    if (input.error || !input.code) {
      const resultCode = await traktConfigurationMutex.run(() =>
        this.failProcessingTransaction(transaction.id, 'access_denied')
      );
      const completion = completionFor(
        resultCode,
        this.httpStatusFor(resultCode)
      );
      this.logCompletion(completion, transaction.targetUserId ?? null, null);
      return completion;
    }

    const settings = getSettings().trakt;
    if (!isTraktConfigured(settings)) {
      const resultCode = await traktConfigurationMutex.run(() =>
        this.failProcessingTransaction(
          transaction.id,
          'trakt_application_not_configured'
        )
      );
      const completion = completionFor(
        resultCode,
        this.httpStatusFor(resultCode)
      );
      this.logCompletion(completion, transaction.targetUserId ?? null, null);
      return completion;
    }

    let tokens: TraktTokenSet;
    let profile: TraktProfile;
    try {
      const api = new TraktAPI(settings.clientId.trim(), settings.clientSecret);
      tokens = await api.exchangeCode(input.code);
      profile = await new TraktAPI(
        settings.clientId.trim(),
        settings.clientSecret,
        tokens.accessToken
      ).getProfile();
    } catch {
      const resultCode = await traktConfigurationMutex.run(() =>
        this.failProcessingTransaction(transaction.id, 'token_exchange_failed')
      );
      const completion = completionFor(
        resultCode,
        this.httpStatusFor(resultCode)
      );
      this.logCompletion(completion, transaction.targetUserId ?? null, null);
      return completion;
    }

    try {
      const persisted = await traktConfigurationMutex.run(() =>
        this.persistCompletion(transaction.id, tokens, profile)
      );
      this.invalidateWatchStatus(persisted.connectionId);
      const completion = completionFor(null, 200);
      this.logCompletion(
        completion,
        transaction.targetUserId ?? null,
        persisted.connectionId
      );
      return completion;
    } catch (error) {
      const requestedResultCode =
        error instanceof TraktConflictError
          ? error.code
          : error instanceof TerminalTransactionError
            ? error.resultCode
            : 'token_exchange_failed';
      const resultCode = await traktConfigurationMutex.run(() =>
        this.failProcessingTransaction(transaction.id, requestedResultCode)
      );
      const completion = completionFor(
        resultCode,
        this.httpStatusFor(resultCode)
      );
      this.logCompletion(completion, transaction.targetUserId ?? null, null);
      return completion;
    }
  }

  public async getTransactionStatus(
    transactionId: string,
    actorUserId: number
  ): Promise<TraktOAuthStatusResponse> {
    return traktConfigurationMutex.run(async () => {
      const repo = getRepository(TraktOAuthTransaction);
      let transaction = await repo.findOneBy({
        id: transactionId,
        actorUserId,
      });
      if (!transaction) {
        throw new Error('Trakt OAuth transaction not found');
      }

      const now = new Date();
      if (
        transaction.status === TraktOAuthTransactionStatus.PENDING &&
        transaction.expiresAt <= now
      ) {
        await repo.update(
          {
            id: transaction.id,
            actorUserId,
            status: TraktOAuthTransactionStatus.PENDING,
            consumedAt: IsNull(),
            expiresAt: LessThanOrEqual(now),
          },
          {
            status: TraktOAuthTransactionStatus.FAILED,
            resultCode: 'state_expired',
            consumedAt: now,
          }
        );
        transaction = await repo.findOneByOrFail({
          id: transaction.id,
          actorUserId,
        });
      } else if (
        transaction.status === TraktOAuthTransactionStatus.PROCESSING &&
        transaction.expiresAt <= now
      ) {
        await repo.update(
          {
            id: transaction.id,
            actorUserId,
            status: TraktOAuthTransactionStatus.PROCESSING,
            consumedAt: IsNull(),
            expiresAt: LessThanOrEqual(now),
          },
          {
            status: TraktOAuthTransactionStatus.FAILED,
            resultCode: 'oauth_interrupted',
            consumedAt: now,
          }
        );
        transaction = await repo.findOneByOrFail({
          id: transaction.id,
          actorUserId,
        });
      }

      if (
        transaction.status === TraktOAuthTransactionStatus.PENDING ||
        transaction.status === TraktOAuthTransactionStatus.PROCESSING
      ) {
        return { status: 'pending', resultCode: null };
      }

      return {
        status:
          transaction.status === TraktOAuthTransactionStatus.SUCCEEDED
            ? 'succeeded'
            : 'failed',
        resultCode: this.toSafeResultCode(transaction.resultCode),
      };
    });
  }

  public async deleteExpiredTransactions(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - RETENTION_MS);
    const result = await getRepository(TraktOAuthTransaction)
      .createQueryBuilder()
      .delete()
      .where('("status" IN (:...unconsumedStatuses) AND "expiresAt" < :cutoff)')
      .orWhere(
        '("status" IN (:...terminalStatuses) AND "consumedAt" < :cutoff)'
      )
      .setParameters({
        unconsumedStatuses: [
          TraktOAuthTransactionStatus.PENDING,
          TraktOAuthTransactionStatus.PROCESSING,
        ],
        terminalStatuses: [
          TraktOAuthTransactionStatus.SUCCEEDED,
          TraktOAuthTransactionStatus.FAILED,
        ],
        cutoff,
      })
      .execute();

    return result.affected ?? 0;
  }

  private async claimTransaction(
    rawState: string
  ): Promise<
    | { transaction: TraktOAuthTransaction }
    | { completion: NotifiableCompletion }
    | null
  > {
    const repo = getRepository(TraktOAuthTransaction);
    const stateHash = this.hashState(rawState);
    const now = new Date();
    const claim = await repo.update(
      {
        stateHash,
        status: TraktOAuthTransactionStatus.PENDING,
        consumedAt: IsNull(),
        expiresAt: MoreThan(now),
      },
      {
        status: TraktOAuthTransactionStatus.PROCESSING,
        expiresAt: new Date(now.getTime() + PROCESSING_LIFETIME_MS),
      }
    );
    const transaction = await repo.findOneBy({ stateHash });

    if (claim.affected === 1 && transaction) {
      return { transaction };
    }
    if (!transaction || !isAllowedTraktOrigin(transaction.origin)) {
      if (transaction) {
        await repo.update(
          {
            id: transaction.id,
            status: In([
              TraktOAuthTransactionStatus.PENDING,
              TraktOAuthTransactionStatus.PROCESSING,
            ]),
            consumedAt: IsNull(),
          },
          {
            status: TraktOAuthTransactionStatus.FAILED,
            resultCode: 'invalid_state',
            consumedAt: now,
          }
        );
      }
      return null;
    }

    let resultCode: TraktSafeResultCode = 'state_replayed';
    if (
      transaction.status === TraktOAuthTransactionStatus.PENDING &&
      transaction.expiresAt <= now
    ) {
      const expired = await repo.update(
        {
          id: transaction.id,
          status: TraktOAuthTransactionStatus.PENDING,
          consumedAt: IsNull(),
          expiresAt: LessThanOrEqual(now),
        },
        {
          status: TraktOAuthTransactionStatus.FAILED,
          resultCode: 'state_expired',
          consumedAt: now,
        }
      );
      resultCode = expired.affected === 1 ? 'state_expired' : 'state_replayed';
    }

    return {
      completion: {
        canNotifyOpener: true,
        transactionId: transaction.id,
        origin: transaction.origin,
        status: 'failed',
        resultCode,
        httpStatus: 400,
      },
    };
  }

  private async validateAuthorization(
    transaction: TraktOAuthTransaction
  ): Promise<
    'invalid_state' | 'target_missing' | 'actor_not_authorized' | null
  > {
    const userRepo = getRepository(User);
    const actor = await userRepo.findOneBy({ id: transaction.actorUserId });
    if (!actor) {
      return 'invalid_state';
    }
    if (!transaction.targetUserId) {
      return 'target_missing';
    }
    const target = await userRepo.findOneBy({ id: transaction.targetUserId });
    if (!target) {
      return 'target_missing';
    }
    if (actor.id !== target.id && !actor.hasPermission(Permission.ADMIN)) {
      return 'actor_not_authorized';
    }
    return null;
  }

  private async persistCompletion(
    transactionId: string,
    tokens: TraktTokenSet,
    profile: TraktProfile
  ): Promise<PersistedCompletion> {
    let uniqueRace: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await dataSource.transaction((manager) =>
          this.persistCompletionTransaction(
            manager,
            transactionId,
            tokens,
            profile
          )
        );
      } catch (error) {
        if (this.isUniqueConstraintError(error) && attempt === 0) {
          uniqueRace = error;
          continue;
        }
        throw error;
      }
    }
    throw uniqueRace;
  }

  private async persistCompletionTransaction(
    manager: EntityManager,
    transactionId: string,
    tokens: TraktTokenSet,
    profile: TraktProfile
  ): Promise<PersistedCompletion> {
    const transactionRepo = manager.getRepository(TraktOAuthTransaction);
    const now = new Date();
    const terminal = await transactionRepo.update(
      {
        id: transactionId,
        status: TraktOAuthTransactionStatus.PROCESSING,
        consumedAt: IsNull(),
      },
      {
        status: TraktOAuthTransactionStatus.SUCCEEDED,
        resultCode: null,
        consumedAt: now,
      }
    );
    if (terminal.affected !== 1) {
      const existing = await transactionRepo.findOneBy({ id: transactionId });
      throw new TerminalTransactionError(
        this.toSafeResultCode(existing?.resultCode) ?? 'invalid_state'
      );
    }

    const transaction = await transactionRepo.findOneByOrFail({
      id: transactionId,
    });
    if (!transaction.targetUserId) {
      throw new TerminalTransactionError('target_missing');
    }

    const userRepo = manager.getRepository(User);
    const [actor, target] = await Promise.all([
      userRepo.findOneBy({ id: transaction.actorUserId }),
      userRepo.findOneBy({ id: transaction.targetUserId }),
    ]);
    if (!actor) {
      throw new TerminalTransactionError('invalid_state');
    }
    if (!target) {
      throw new TerminalTransactionError('target_missing');
    }
    if (actor.id !== target.id && !actor.hasPermission(Permission.ADMIN)) {
      throw new TerminalTransactionError('actor_not_authorized');
    }

    const connectionRepo = manager.getRepository(TraktConnection);
    const targetConnection = await connectionRepo.findOne({
      where: { userId: transaction.targetUserId },
    });
    const identityConnection = await connectionRepo.findOne({
      where: { traktUserId: profile.traktUserId },
    });

    if (
      targetConnection &&
      targetConnection.traktUserId !== profile.traktUserId
    ) {
      throw new TraktConflictError('target_has_different_trakt_account');
    }

    if (
      identityConnection &&
      identityConnection.userId !== transaction.targetUserId
    ) {
      throw new TraktConflictError('trakt_account_owned_by_another_user');
    }

    const connection =
      targetConnection ??
      connectionRepo.create({
        userId: transaction.targetUserId,
        traktUserId: profile.traktUserId,
        tokenVersion: 0,
      });
    connection.traktUserId = profile.traktUserId;
    connection.username = profile.username;
    connection.slug = profile.slug;
    connection.displayName = profile.displayName;
    connection.status = TraktConnectionStatus.ACTIVE;
    connection.accessToken = tokens.accessToken;
    connection.refreshToken = tokens.refreshToken;
    connection.expiresAt = tokens.expiresAt;
    connection.connectedByUserId = actor.id;
    connection.lastValidatedAt = now;
    connection.tokenVersion += 1;
    const saved = await connectionRepo.save(connection);

    return { connectionId: saved.id };
  }

  private async failProcessingTransaction(
    transactionId: string,
    resultCode: TraktSafeResultCode
  ): Promise<TraktSafeResultCode> {
    const repo = getRepository(TraktOAuthTransaction);
    const failure = await repo.update(
      {
        id: transactionId,
        status: TraktOAuthTransactionStatus.PROCESSING,
        consumedAt: IsNull(),
      },
      {
        status: TraktOAuthTransactionStatus.FAILED,
        resultCode,
        consumedAt: new Date(),
      }
    );
    if (failure.affected === 1) {
      return resultCode;
    }

    const durable = await repo.findOneBy({ id: transactionId });
    return this.toSafeResultCode(durable?.resultCode) ?? 'invalid_state';
  }

  private invalidateWatchStatus(connectionId: number): void {
    const cache = cacheManager.getCache('trakt-watch-status').data;
    const keys = cache
      .keys()
      .filter((key) => key.startsWith(`${connectionId}:`));
    if (keys.length > 0) {
      cache.del(keys);
    }
  }

  private logCompletion(
    completion: NotifiableCompletion,
    targetUserId: number | null,
    connectionId: number | null
  ): void {
    logger.info('Trakt OAuth completion finished', {
      label: 'Trakt',
      operation: 'oauth_complete',
      connectionId,
      targetUserId,
      httpClass: `${Math.floor(completion.httpStatus / 100)}xx`,
      resultCode: completion.resultCode ?? 'succeeded',
    });
  }

  private invalidState(): TraktAuthorizationCompletion {
    return {
      canNotifyOpener: false,
      status: 'failed',
      resultCode: 'invalid_state',
      httpStatus: 400,
    };
  }

  private httpStatusFor(resultCode: TraktSafeResultCode): 400 | 409 {
    return resultCode === 'target_has_different_trakt_account' ||
      resultCode === 'trakt_account_owned_by_another_user'
      ? 409
      : 400;
  }

  private hashState(rawState: string): string {
    return createHash('sha256').update(rawState).digest('hex');
  }

  private toSafeResultCode(value: string | null | undefined) {
    return value && safeResultCodes.has(value as TraktSafeResultCode)
      ? (value as TraktSafeResultCode)
      : null;
  }

  private isUniqueConstraintError(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) {
      return false;
    }
    const driverError = error.driverError as {
      code?: unknown;
      errno?: unknown;
    };
    return (
      driverError.code === '23505' ||
      driverError.code === 'SQLITE_CONSTRAINT' ||
      driverError.errno === 19
    );
  }
}
