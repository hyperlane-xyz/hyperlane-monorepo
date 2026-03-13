import { type ChainName } from '@hyperlane-xyz/sdk';

import { type MonitorEvent } from './IMonitor.js';

export interface IMetrics {
  processToken(tokenInfo: MonitorEvent['tokensInfo'][number]): Promise<void>;
  updateInventoryBalance(
    chain: ChainName,
    balance: bigint,
    warpRouteId: string,
  ): void;
  recordInventoryBalanceFetchFailure(chain: ChainName): void;
  recordCycleError(errorType: string): void;
  recordTxFailure(
    origin: ChainName,
    destination: ChainName,
    failureReason: string,
  ): void;
  recordBridgeFailure(
    sourceChain: ChainName,
    targetChain: ChainName,
    failureReason: string,
  ): void;
}
