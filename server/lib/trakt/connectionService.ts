import TraktAPI, {
  TraktApiError,
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
  TraktPublicSettings,
  TraktSafeResultCode,
  TraktSettingsUpdate,
} from '@server/interfaces/api/traktInterfaces';
import cacheManager from '@server/lib/cache';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import {
  getSafeTraktSettings,
  isAllowedTraktOrigin,
  isTraktConfigured,
} from '@server/lib/trakt/config';
import { traktConfigurationMutex } from '@server/lib/trakt/configurationMutex';
import {
  TraktRefreshCoordinator,
  type TraktAccessContext,
} from '@server/lib/trakt/refreshCoordinator';
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
const REFRESH_WINDOW_MS = 60 * 1000;

const refreshCoordinator = new TraktRefreshCoordinator();
const cooldownUntil = new Map<number, number>();

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

export interface TraktUnlinkResult {
  remoteRevocationSucceeded: boolean;
}

class TerminalTransactionError extends Error {
  public constructor(public readonly resultCode: TraktSafeResultCode) {
    super(resultCode);
  }
}

export class TraktConnectionService {
  public updateApplicationSettings(
    actorUserId: number,
    update: TraktSettingsUpdate
  ): Promise<TraktPublicSettings> {
    return traktConfigurationMutex.run(async () => {
      if (typeof update.clientId !== 'string') {
        throw new Error('Trakt client ID is required');
      }
      if (
        update.clientSecret !== undefined &&
        update.clientSecret.length === 0
      ) {
        throw new Error('Trakt client secret must not be empty');
      }

      const settings = getSettings();
      const previous = { ...settings.trakt };
      const normalizedClientId = update.clientId.trim();
      const clientIdChanged =
        previous.clientId.trim().length > 0 &&
        normalizedClientId !== previous.clientId.trim();

      if (clientIdChanged && update.confirmReconnectAll !== true) {
        throw new Error('Confirm reconnect all is required');
      }

      let affectedConnectionCount = 0;
      if (clientIdChanged) {
        const now = new Date();
        await dataSource.transaction(async (manager) => {
          const connectionResult = await manager
            .getRepository(TraktConnection)
            .createQueryBuilder()
            .update(TraktConnection)
            .set({
              accessToken: null,
              refreshToken: null,
              expiresAt: null,
              status: TraktConnectionStatus.RECONNECT_REQUIRED,
              tokenVersion: () => '"tokenVersion" + 1',
            })
            .execute();
          affectedConnectionCount = connectionResult.affected ?? 0;

          await manager
            .getRepository(TraktOAuthTransaction)
            .createQueryBuilder()
            .update(TraktOAuthTransaction)
            .set({
              status: TraktOAuthTransactionStatus.FAILED,
              resultCode: 'client_id_changed',
              consumedAt: now,
            })
            .where('"status" IN (:...statuses)', {
              statuses: [
                TraktOAuthTransactionStatus.PENDING,
                TraktOAuthTransactionStatus.PROCESSING,
              ],
            })
            .execute();
        });
        cacheManager.getCache('trakt-watch-status').flush();
      }

      try {
        settings.trakt = {
          clientId: normalizedClientId,
          ...(update.clientSecret !== undefined && {
            clientSecret: update.clientSecret,
          }),
        };
        await settings.save();
      } catch (error) {
        settings.trakt.clientId = previous.clientId;
        settings.trakt.clientSecret = previous.clientSecret;
        logger.error('Trakt application settings update failed', {
          label: 'Trakt',
          operation: 'application_settings_persist_failed',
          actorUserId,
          affectedConnectionCount,
          errorClass: error instanceof Error ? error.name : 'UnknownError',
        });
        throw error;
      }

      logger.info('Trakt application settings updated', {
        label: 'Trakt',
        operation: clientIdChanged
          ? 'application_client_id_changed'
          : 'application_settings_updated',
        actorUserId,
        affectedConnectionCount,
      });
      return getSafeTraktSettings(settings.trakt);
    });
  }

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

      logger.info('Trakt OAuth authorization started', {
        label: 'Trakt',
        operation: 'oauth_start',
        actorUserId: actor.id,
        targetUserId: target.id,
      });

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

  public async withAuthenticatedApi<T>(
    userId: number,
    operation: (api: TraktAPI) => Promise<T>
  ): Promise<T> {
    const connection = await this.findConnectionWithTokensByUserId(userId);
    if (!connection) {
      throw new Error('Trakt connection not found');
    }

    this.throwIfCoolingDown(connection.id);
    let context = this.toAccessContext(connection);
    if (
      !connection.expiresAt ||
      connection.expiresAt.getTime() <= Date.now() + REFRESH_WINDOW_MS
    ) {
      context = await this.refreshAccess(
        connection.id,
        connection.tokenVersion
      );
    }

    try {
      return await this.runAuthenticatedOperation(context, operation);
    } catch (error) {
      this.rememberRateLimit(context.connectionId, error);
      if (!this.isUnauthorized(error)) {
        throw error;
      }
    }

    const replacement = await this.refreshAccess(
      context.connectionId,
      context.tokenVersion
    );
    try {
      return await this.runAuthenticatedOperation(replacement, operation);
    } catch (error) {
      this.rememberRateLimit(replacement.connectionId, error);
      throw error;
    }
  }

  public async unlink(
    targetUserId: number,
    actorUserId = targetUserId
  ): Promise<TraktUnlinkResult> {
    const connection =
      await this.findConnectionWithTokensByUserId(targetUserId);
    if (!connection) {
      throw new Error('Trakt connection not found');
    }

    let remoteRevocationSucceeded = false;
    let errorClass: string | null = null;
    try {
      if (connection.accessToken) {
        await this.apiFor().revoke(connection.accessToken);
        remoteRevocationSucceeded = true;
      }
    } catch (error) {
      errorClass = error instanceof Error ? error.name : 'UnknownError';
    } finally {
      await getRepository(TraktConnection).delete({ id: connection.id });
      cooldownUntil.delete(connection.id);
      this.invalidateWatchStatus(connection.id);
    }

    logger.info('Trakt connection unlinked', {
      label: 'Trakt',
      operation: 'unlink',
      connectionId: connection.id,
      actorUserId,
      targetUserId,
      remoteRevocationSucceeded,
      errorClass,
    });

    return { remoteRevocationSucceeded };
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

  private async refreshAccess(
    connectionId: number,
    expectedTokenVersion: number
  ): Promise<TraktAccessContext> {
    return refreshCoordinator.run(connectionId, async () => {
      const connection = await this.findConnectionWithTokensById(connectionId);
      if (!connection) {
        throw new Error('Trakt connection not found');
      }
      if (connection.tokenVersion !== expectedTokenVersion) {
        return this.toAccessContext(connection);
      }
      if (
        connection.status !== TraktConnectionStatus.ACTIVE ||
        !connection.refreshToken
      ) {
        throw new Error('Trakt connection requires reconnection');
      }

      let replacement: TraktTokenSet;
      try {
        replacement = await this.apiFor().refresh(connection.refreshToken);
      } catch (error) {
        this.rememberRateLimit(connection.id, error);
        if (!this.isInvalidRefreshCredentials(error)) {
          throw error;
        }

        const invalidated = await getRepository(TraktConnection).update(
          {
            id: connection.id,
            tokenVersion: connection.tokenVersion,
          },
          {
            accessToken: null,
            refreshToken: null,
            expiresAt: null,
            tokenVersion: connection.tokenVersion + 1,
            status: TraktConnectionStatus.RECONNECT_REQUIRED,
          }
        );
        if (invalidated.affected === 1) {
          this.invalidateWatchStatus(connection.id);
          logger.warn('Trakt connection requires reconnection', {
            label: 'Trakt',
            operation: 'reconnect_required',
            connectionId: connection.id,
            tokenVersion: connection.tokenVersion + 1,
            resultCode: 'invalid_refresh',
          });
          throw error;
        }

        return this.loadWinningAccessContext(connection.id);
      }

      const updated = await getRepository(TraktConnection).update(
        {
          id: connection.id,
          tokenVersion: connection.tokenVersion,
        },
        {
          accessToken: replacement.accessToken,
          refreshToken: replacement.refreshToken,
          expiresAt: replacement.expiresAt,
          tokenVersion: connection.tokenVersion + 1,
          status: TraktConnectionStatus.ACTIVE,
        }
      );
      if (updated.affected !== 1) {
        return this.loadWinningAccessContext(connection.id);
      }

      this.invalidateWatchStatus(connection.id);
      logger.info('Trakt access token refreshed', {
        label: 'Trakt',
        operation: 'token_refresh',
        connectionId: connection.id,
        tokenVersion: connection.tokenVersion + 1,
        resultCode: 'succeeded',
      });
      return {
        connectionId: connection.id,
        accessToken: replacement.accessToken,
        tokenVersion: connection.tokenVersion + 1,
      };
    });
  }

  private async loadWinningAccessContext(
    connectionId: number
  ): Promise<TraktAccessContext> {
    const winner = await this.findConnectionWithTokensById(connectionId);
    if (!winner) {
      throw new Error('Trakt connection not found');
    }
    return this.toAccessContext(winner);
  }

  private findConnectionWithTokensByUserId(
    userId: number
  ): Promise<TraktConnection | null> {
    return getRepository(TraktConnection)
      .createQueryBuilder('connection')
      .addSelect(['connection.accessToken', 'connection.refreshToken'])
      .where('connection.userId = :userId', { userId })
      .getOne();
  }

  private findConnectionWithTokensById(
    connectionId: number
  ): Promise<TraktConnection | null> {
    return getRepository(TraktConnection)
      .createQueryBuilder('connection')
      .addSelect(['connection.accessToken', 'connection.refreshToken'])
      .where('connection.id = :connectionId', { connectionId })
      .getOne();
  }

  private toAccessContext(connection: TraktConnection): TraktAccessContext {
    if (
      connection.status !== TraktConnectionStatus.ACTIVE ||
      !connection.accessToken
    ) {
      throw new Error('Trakt connection requires reconnection');
    }
    return {
      connectionId: connection.id,
      accessToken: connection.accessToken,
      tokenVersion: connection.tokenVersion,
    };
  }

  private apiFor(accessToken?: string): TraktAPI {
    const settings = getSettings().trakt;
    if (!isTraktConfigured(settings)) {
      throw new Error('Trakt application is not configured');
    }
    return new TraktAPI(
      settings.clientId.trim(),
      settings.clientSecret,
      accessToken
    );
  }

  private async runAuthenticatedOperation<T>(
    context: TraktAccessContext,
    operation: (api: TraktAPI) => Promise<T>
  ): Promise<T> {
    const api = this.apiFor(context.accessToken);
    const result = await operation(api);
    if (api.didValidateAccessToken()) {
      await this.markValidated(context);
    }
    return result;
  }

  private async markValidated(context: TraktAccessContext): Promise<void> {
    await getRepository(TraktConnection).update(
      {
        id: context.connectionId,
        tokenVersion: context.tokenVersion,
        status: TraktConnectionStatus.ACTIVE,
      },
      { lastValidatedAt: new Date() }
    );
  }

  private isUnauthorized(error: unknown): error is TraktApiError {
    return error instanceof TraktApiError && error.status === 401;
  }

  private isInvalidRefreshCredentials(error: unknown): error is TraktApiError {
    return (
      error instanceof TraktApiError &&
      (error.status === 400 || error.status === 401)
    );
  }

  private rememberRateLimit(connectionId: number, error: unknown): void {
    if (
      !(error instanceof TraktApiError) ||
      error.status !== 429 ||
      error.retryAfterSeconds === undefined
    ) {
      return;
    }
    cooldownUntil.set(
      connectionId,
      Date.now() + error.retryAfterSeconds * 1000
    );
  }

  private throwIfCoolingDown(connectionId: number): void {
    const deadline = cooldownUntil.get(connectionId);
    if (deadline === undefined) {
      return;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      cooldownUntil.delete(connectionId);
      return;
    }
    throw new TraktApiError(
      'Trakt rate limit exceeded',
      429,
      'RATE_LIMITED',
      Math.ceil(remainingMs / 1000)
    );
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
      .filter((key) => key.startsWith(`connection:${connectionId}:`));
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
