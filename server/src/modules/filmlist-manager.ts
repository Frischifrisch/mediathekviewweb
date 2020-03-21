import { AsyncEnumerable } from '@tstdl/base/enumerable';
import { Logger } from '@tstdl/base/logger';
import { Queue } from '@tstdl/base/queue';
import { AnyIterable, currentTimestamp } from '@tstdl/base/utils';
import { CancellationToken } from '@tstdl/base/utils/cancellation-token';
import { DistributedLoopProvider } from '@tstdl/server/distributed-loop';
import { Module, ModuleBase, ModuleMetricType } from '@tstdl/server/module';
import { config } from '../config';
import { Filmlist } from '../entry-source/filmlist/filmlist';
import { FilmlistProvider } from '../entry-source/filmlist/provider';
import { keys } from '../keys';
import { FilmlistImportQueueItem, FilmlistImportWithPartialId } from '../models';
import { FilmlistImportRepository } from '../repositories/filmlist-import-repository';
import { KeyValueRepository } from '../repositories/key-value-repository';

const LATEST_CHECK_INTERVAL = config.importer.latestCheckIntervalMinutes * 60 * 1000;
const ARCHIVE_CHECK_INTERVAL = config.importer.archiveCheckIntervalMinutes * 60 * 1000;
const MAX_AGE_DAYS = config.importer.archiveRange;
const MAX_AGE_MILLISECONDS = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
const KEY_VALUE_SCOPE = 'filmlist-manager';

type FilmlistManagerKeyValues = {
  lastLatestCheck: number,
  lastArchiveCheck: number
};

export class FilmlistManagerModule extends ModuleBase implements Module {
  private readonly keyValueRepository: KeyValueRepository<FilmlistManagerKeyValues>;
  private readonly filmlistImportRepository: FilmlistImportRepository;
  private readonly filmlistImportQueue: Queue<FilmlistImportQueueItem>;
  private readonly filmlistProvider: FilmlistProvider;
  private readonly distributedLoopProvider: DistributedLoopProvider;
  private readonly logger: Logger;

  private enqueuedFilmlistsCount: number;

  readonly metrics = {
    enqueuedFilmlistsCount: {
      type: ModuleMetricType.Counter,
      getValue: () => this.enqueuedFilmlistsCount // eslint-disable-line no-invalid-this
    }
  };

  constructor(keyValueRepository: KeyValueRepository<FilmlistManagerKeyValues>, filmlistImportRepository: FilmlistImportRepository, filmlistImportQueue: Queue<FilmlistImportQueueItem>, filmlistProvider: FilmlistProvider, distributedLoopProvider: DistributedLoopProvider, logger: Logger) {
    super('FilmlistManager');

    this.keyValueRepository = keyValueRepository;
    this.filmlistImportRepository = filmlistImportRepository;
    this.filmlistImportQueue = filmlistImportQueue;
    this.filmlistProvider = filmlistProvider;
    this.distributedLoopProvider = distributedLoopProvider;
    this.logger = logger;
  }

  protected async _run(_cancellationToken: CancellationToken): Promise<void> {
    const distributedLoop = this.distributedLoopProvider.get(keys.FilmlistManagerLoop);

    const loopController = distributedLoop.run(async () => this.check(), 60000, 10000);
    await this.cancellationToken;

    await loopController.stop();
  }

  private async check(): Promise<void> {
    await this.compareTime('lastLatestCheck', LATEST_CHECK_INTERVAL, async () => this.checkLatest());
    await this.compareTime('lastArchiveCheck', ARCHIVE_CHECK_INTERVAL, async () => this.checkArchive());
  }

  private async compareTime(key: keyof FilmlistManagerKeyValues, interval: number, func: () => Promise<void>): Promise<void> {
    const lastCheck = await this.keyValueRepository.get(KEY_VALUE_SCOPE, key, 0);
    const now = currentTimestamp();
    const difference = now - lastCheck;

    if (difference >= interval) {
      await func();
      await this.keyValueRepository.set(KEY_VALUE_SCOPE, key, now);
    }
  }

  private async checkLatest(): Promise<void> {
    this.logger.verbose('checking for new current-filmlist');
    const filmlists = this.filmlistProvider.getLatest();
    await this.enqueueMissingFilmlists(filmlists, 0);
  }

  private async checkArchive(): Promise<void> {
    this.logger.verbose('checking for new archive-filmlist');

    const minimumTimestamp = currentTimestamp() - MAX_AGE_MILLISECONDS;

    const archive = this.filmlistProvider.getArchive();
    await this.enqueueMissingFilmlists(archive, minimumTimestamp);
  }

  private async enqueueMissingFilmlists(filmlists: AnyIterable<Filmlist>, minimumTimestamp: number): Promise<void> {
    const filmlistsEnumerable = new AsyncEnumerable(filmlists);

    await filmlistsEnumerable
      .while(() => !this.cancellationToken.isSet)
      .filter((filmlist) => filmlist.resource.timestamp >= minimumTimestamp)
      .filter(async (filmlist) => !(await this.filmlistImportRepository.hasResource(filmlist.resource.id)))
      .forEach(async (filmlist) => this.enqueueFilmlist(filmlist));
  }

  private async enqueueFilmlist(filmlist: Filmlist): Promise<void> {
    const filmlistImport: FilmlistImportWithPartialId = {
      resource: filmlist.resource,
      state: 'pending',
      enqueueTimestamp: currentTimestamp(),
      filmlistMetadata: null,
      importTimestamp: null,
      importDuration: null,
      entriesCount: null
    };

    const insertedFilmlistImport = await this.filmlistImportRepository.save(filmlistImport);

    const filmlistImportQueueItem: FilmlistImportQueueItem = {
      filmlistImportId: insertedFilmlistImport.id
    };

    await this.filmlistImportQueue.enqueue(filmlistImportQueueItem);
    this.enqueuedFilmlistsCount++;
  }
}
