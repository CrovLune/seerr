import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableColumn, TableForeignKey, TableIndex } from 'typeorm';

export class AddTraktWatchedItems1787910000000 implements MigrationInterface {
  name = 'AddTraktWatchedItems1787910000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'trakt_watched_item',
        columns: [
          {
            name: 'id',
            type: 'integer',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          { name: 'connectionId', type: 'integer' },
          { name: 'mediaType', type: 'varchar' },
          { name: 'tmdbId', type: 'integer' },
          { name: 'watchedEpisodes', type: 'integer', default: 0 },
          { name: 'airedEpisodes', type: 'integer', isNullable: true },
          {
            name: 'lastWatchedAt',
            type: 'timestamp with time zone',
            isNullable: true,
          },
        ],
      }),
      true
    );

    await queryRunner.createForeignKey(
      'trakt_watched_item',
      new TableForeignKey({
        columnNames: ['connectionId'],
        referencedTableName: 'trakt_connection',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
      })
    );

    await queryRunner.createIndex(
      'trakt_watched_item',
      new TableIndex({
        name: 'UQ_trakt_watched_item_connection_media',
        columnNames: ['connectionId', 'mediaType', 'tmdbId'],
        isUnique: true,
      })
    );

    await queryRunner.createIndex(
      'trakt_watched_item',
      new TableIndex({
        name: 'IDX_trakt_watched_item_media_connection',
        columnNames: ['mediaType', 'tmdbId', 'connectionId'],
      })
    );

    await queryRunner.addColumns('trakt_connection', [
      new TableColumn({
        name: 'lastWatchedSuccessfulSyncAt',
        type: 'timestamp with time zone',
        isNullable: true,
      }),
      new TableColumn({
        name: 'lastWatchedSyncStatus',
        type: 'varchar',
        isNullable: true,
      }),
    ]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('trakt_connection', 'lastWatchedSyncStatus');
    await queryRunner.dropColumn(
      'trakt_connection',
      'lastWatchedSuccessfulSyncAt'
    );
    await queryRunner.dropTable('trakt_watched_item', true);
  }
}
