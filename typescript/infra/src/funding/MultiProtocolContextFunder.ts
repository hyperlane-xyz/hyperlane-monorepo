import { Gauge } from 'prom-client';

import { ChainMap, MultiProtocolProvider } from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { DeployEnvironment } from '../config/environment.js';

import { MultiProtocolFundingApp } from './MultiProtocolFundingApp.js';
import { createTimeoutPromise } from './helpers.js';
import { ChainFundingPlan, FundingAddresses, FundingConfig } from './types.js';

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
    private readonly fundingConfig: FundingConfig,
    private readonly walletBalanceGauge: Gauge<string>,
    fundingAddresses: ChainMap<FundingAddresses>,
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
      Object.entries(this.fundingPlan).map(([chain, plan]) => {
        const { promise, cleanup } = createTimeoutPromise(
          CHAIN_FUNDING_TIMEOUT_MS,
          `Funding timed out for chain ${chain} after ${
            CHAIN_FUNDING_TIMEOUT_MS / 1000
          }s`,
        );

        try {
          return Promise.race([
            this.fundingApp.fundChainKeys(chain, plan),
            promise,
          ]);
        } catch (error) {
          this.logger.error({ error, chain }, 'Error funding chain');
          return Promise.reject(error);
        } finally {
          cleanup();
        }
      }),
    );

    if (results.some((result) => result.status === 'rejected')) {
      this.logger.error('One or more chains failed to fund');
      throw new Error('One or more chains failed to fund');
    }
  }
}
