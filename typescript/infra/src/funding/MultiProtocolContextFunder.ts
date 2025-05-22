import { Gauge } from 'prom-client';

import { ChainMap, MultiProtocolProvider } from '@hyperlane-xyz/sdk';
import { rootLogger, runWithTimeout } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { DeployEnvironment } from '../config/environment.js';

import { MultiProtocolFundingApp } from './MultiProtocolFundingApp.js';
import { ChainFundingPlan, FunderAddresses, FunderConfig } from './types.js';

const CHAIN_FUNDING_TIMEOUT_MS = 1 * 60 * 1000; // 1 minute

/**
 * Implementation of a multi-protocol context funder
 *
 * This class is responsible for funding keys for a given context on a given environment
 * It is responsible for creating the funding app and funding keys for a given context
 * It is also responsible for timing out the funding process if it takes too long
 */
export class MultiProtocolContextFunder {
  private fundingApp: MultiProtocolFundingApp;
  private fundingPlan: ChainMap<ChainFundingPlan>;
  private readonly logger = rootLogger.child({
    module: 'multi-protocol-context-funder',
  });

  constructor(
    public readonly context: Contexts,
    private readonly environment: DeployEnvironment,
    private readonly multiProtocolProvider: MultiProtocolProvider,
    private readonly fundingConfig: FunderConfig,
    private readonly walletBalanceGauge: Gauge<string>,
    fundingAddresses: ChainMap<FunderAddresses>,
    fundingPlan: ChainMap<ChainFundingPlan>,
  ) {
    this.fundingApp = new MultiProtocolFundingApp(
      this.multiProtocolProvider,
      fundingAddresses,
      this.environment,
      this.context,
      this.fundingConfig,
      this.walletBalanceGauge,
    );
    this.fundingPlan = fundingPlan;
  }

  /**
   * Funds the keys for the given context on the given environment
   */
  async fund(): Promise<void> {
    const results = await Promise.allSettled(
      Object.entries(this.fundingPlan).map(async ([chain, plan]) => {
        try {
          return await runWithTimeout(
            CHAIN_FUNDING_TIMEOUT_MS,
            () => this.fundingApp.fundChainKeys(chain, plan),
            `Funding timed out for chain ${chain} after ${
              CHAIN_FUNDING_TIMEOUT_MS / 1000
            }s`,
          );
        } catch (error) {
          this.logger.error({ error, chain }, 'Error funding chain');
          return Promise.reject({ error, chain });
        }
      }),
    );

    const failedChains = results.reduce((acc, result) => {
      if (result.status === 'rejected') {
        const chainName = result.reason.chain;
        acc.push(chainName);
      }
      return acc;
    }, [] as string[]);

    if (failedChains.length > 0) {
      const errorMessage = `One or more chains failed to fund: ${failedChains.join(', ')}`;
      this.logger.error(errorMessage);
      throw new Error(errorMessage);
    }
  }
}
