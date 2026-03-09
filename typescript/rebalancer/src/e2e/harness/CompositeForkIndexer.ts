import type { ConfirmedBlockTags } from '../../interfaces/IMonitor.js';
import type { ExplorerMessage } from '../../utils/ExplorerClient.js';
import type { IForkIndexer } from './IForkIndexer.js';

export class CompositeForkIndexer implements IForkIndexer {
  constructor(private readonly indexers: IForkIndexer[]) {}

  async initialize(confirmedBlockTags: ConfirmedBlockTags): Promise<void> {
    await Promise.all(
      this.indexers.map((idx) => idx.initialize(confirmedBlockTags)),
    );
  }

  async sync(confirmedBlockTags: ConfirmedBlockTags): Promise<void> {
    await Promise.all(this.indexers.map((idx) => idx.sync(confirmedBlockTags)));
  }

  getUserTransfers(): ExplorerMessage[] {
    return this.indexers.flatMap((idx) => idx.getUserTransfers());
  }

  getRebalanceActions(): ExplorerMessage[] {
    return this.indexers.flatMap((idx) => idx.getRebalanceActions());
  }
}
