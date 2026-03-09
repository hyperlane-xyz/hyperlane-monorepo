import type { ConfirmedBlockTags } from '../../interfaces/IMonitor.js';
import type { ExplorerMessage } from '../../utils/ExplorerClient.js';

export interface IForkIndexer {
  initialize(confirmedBlockTags: ConfirmedBlockTags): Promise<void>;
  sync(confirmedBlockTags: ConfirmedBlockTags): Promise<void>;
  getUserTransfers(): ExplorerMessage[];
  getRebalanceActions(): ExplorerMessage[];
}
