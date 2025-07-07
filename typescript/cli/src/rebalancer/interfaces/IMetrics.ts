import { MonitorEvent } from './IMonitor.js';

export interface IMetrics {
  processToken(tokenInfo: MonitorEvent['tokensInfo'][number]): Promise<void>;
}
