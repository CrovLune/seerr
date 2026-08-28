/**
 * Serialises watched-library syncs per connection. Unlike `TraktRefreshCoordinator`, a second
 * caller does not join the first's in-flight run — it waits for it to settle and then runs its
 * own operation. A link-triggered sync that merely joined an in-flight scheduled run could
 * resolve before the newly linked connection was observable, leaving it unsynced for a full
 * scheduling tick. The map holds one entry per connection, overwritten on every call, so its
 * size is bounded by the number of Trakt connections rather than the number of calls — there is
 * nothing to clean up.
 */
class TraktWatchedSyncCoordinator {
  private readonly inFlight = new Map<number, Promise<unknown>>();

  public async run<T>(
    connectionId: number,
    operation: () => Promise<T>
  ): Promise<T> {
    const pending = this.inFlight.get(connectionId) ?? Promise.resolve();
    const next = pending.then(operation, operation);
    this.inFlight.set(connectionId, next);
    // Detached so a rejection isn't also reported as unhandled; callers observe it via `next`.
    next.catch(() => undefined);
    return next;
  }
}

export const traktWatchedSyncCoordinator = new TraktWatchedSyncCoordinator();
