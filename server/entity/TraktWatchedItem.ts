import { TraktConnection } from '@server/entity/TraktConnection';
import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

export type TraktWatchedMediaType = 'movie' | 'tv';

/**
 * A single title a Trakt connection has watched. Rows exist only for watched
 * titles: absence means not-started, which is why a snapshot is never committed
 * unless every page of it was fetched successfully.
 */
@Entity('trakt_watched_item')
@Unique(['connectionId', 'mediaType', 'tmdbId'])
@Index(['mediaType', 'tmdbId', 'connectionId'])
export class TraktWatchedItem {
  @PrimaryGeneratedColumn()
  public id: number;

  @ManyToOne(() => TraktConnection, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'connectionId' })
  public connection: TraktConnection;

  @Column({ type: 'int' })
  public connectionId: number;

  @Column({ type: 'varchar' })
  public mediaType: TraktWatchedMediaType;

  @Column({ type: 'int' })
  public tmdbId: number;

  @Column({ type: 'int', default: 0 })
  public watchedEpisodes: number;

  @Column({ type: 'int', nullable: true })
  public airedEpisodes: number | null;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public lastWatchedAt: Date | null;
}
