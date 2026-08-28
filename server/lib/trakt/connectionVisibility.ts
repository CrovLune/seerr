import { getRepository } from '@server/datasource';
import {
  TraktConnection,
  TraktConnectionStatus,
} from '@server/entity/TraktConnection';
import type { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';

export type TraktMediaType = 'movie' | 'tv';

/**
 * Household visibility rule shared by every Trakt watch-status read path: admins see every
 * active connection, everyone else sees only their own. Callers select only the columns they
 * need -- e.g. the card service needs `lastWatchedSuccessfulSyncAt`, the detail service needs
 * `tokenVersion` instead.
 */
export function getVisibleConnections(
  viewer: User,
  selectFields: string[]
): Promise<TraktConnection[]> {
  const query = getRepository(TraktConnection)
    .createQueryBuilder('connection')
    .innerJoinAndSelect('connection.user', 'user')
    .select(selectFields)
    .where('connection.status = :status', {
      status: TraktConnectionStatus.ACTIVE,
    })
    .orderBy('connection.userId', 'ASC');

  if (!viewer.hasPermission(Permission.ADMIN)) {
    query.andWhere('connection.userId = :viewerId', {
      viewerId: viewer.id,
    });
  }

  return query.getMany();
}

export function displayNameFor(connection: TraktConnection): string {
  const user = connection.user;
  return (
    user.displayName ||
    user.username ||
    user.plexUsername ||
    user.jellyfinUsername ||
    'Seerr user'
  );
}
