/**
 * Serialises watched-library syncs per connection. Unlike `TraktRefreshCoordinator`, a second
 * caller does not join the first's in-flight run — it waits for it to settle and then runs its
 * own operation. A link-triggered sync that merely joined an in-flight scheduled run could
 * resolve before the newly linked connection was observable, leaving it unsynced for a full
 * scheduling tick.
 */
class TraktWatchedSyncCoordinator {
  private readonly inFlight = new Map<number, Promise<unknown>>();

  public async run<T>(
    connectionId: number,
    operation: () => Promise<T>
  ): Promise<T> {
    const pending = this.inFlight.get(connectionId) ?? Promise.resolve();
    const next = pending.then(operation, operation);
    this.inFlight.set(
      connectionId,
      next
        .catch(() => undefined)
        .finally(() => {
          if (this.inFlight.get(connectionId) === next) {
            this.inFlight.delete(connectionId);
          }
        })
    );
    return next;
  }
}

export const traktWatchedSyncCoordinator = new TraktWatchedSyncCoordinator();
