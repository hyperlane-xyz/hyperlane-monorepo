import { Logger } from 'pino';
import { Gauge } from 'prom-client';

import {
  AdapterClassType,
  ChainMap,
  ChainName,
  MultiProtocolApp,
  MultiProtocolProvider,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { DeployEnvironment } from '../config/environment.js';

import { EVMFundingAdapter } from './adapters/EVMFundingAdapter.js';
import { IFundingAdapter } from './adapters/IFundingAdapter.js';
import { SealevelFundingAdapter } from './adapters/SealevelFundingAdapter.js';
import { ChainFundingPlan, FundingAddresses, FundingConfig } from './types.js';

export class MultiProtocolFundingApp extends MultiProtocolApp<
  IFundingAdapter,
  FundingAddresses
> {
  public readonly logger: Logger;

  constructor(
    private readonly multiProtocolProvider: MultiProtocolProvider,
    public readonly addresses: ChainMap<FundingAddresses>,
    private readonly environment: DeployEnvironment,
    private readonly context: Contexts,
    private readonly config: FundingConfig,
    private readonly walletBalanceGauge: Gauge<string>,
    logger: Logger = rootLogger.child({ module: 'multi-protocol-funding-app' }),
  ) {
    super(multiProtocolProvider, addresses, logger);
    this.logger = logger;
  }

  override protocolToAdapter(
    protocol: ProtocolType,
  ): AdapterClassType<IFundingAdapter> {
    if (protocol === ProtocolType.Ethereum) return EVMFundingAdapter;
    if (protocol === ProtocolType.Sealevel) return SealevelFundingAdapter;
    throw new Error(`No adapter for protocol ${protocol}`);
  }

  override adapter(chain: ChainName): IFundingAdapter {
    const Adapter = this.protocolToAdapter(this.protocol(chain));
    return new Adapter(
      chain,
      this.multiProtocolProvider,
      this.environment,
      this.context,
      this.addresses[chain],
      this.logger,
      this.walletBalanceGauge,
    );
  }

  // Fund specific keys on a specific chain
  async fundChainKeys(
    chain: ChainName,
    fundingPlan: ChainFundingPlan,
  ): Promise<void> {
    const adapter = this.adapter(chain);
    const errors: unknown[] = [];

    // Handle IGP claims first if enabled
    if (!this.config.skipIgpClaim) {
      try {
        await adapter.claimFromIgp(fundingPlan.igpClaimThreshold);
      } catch (error) {
        this.logger.error({ chain, error }, 'Failed to claim from IGP');
        errors.push(error);
      }
    }

    // Fund each key
    for (const keyToFund of fundingPlan.keysToFund) {
      try {
        await adapter.fundKey(
          keyToFund.key,
          keyToFund.desiredBalance,
          this.config.fundingThresholdFactor,
        );
        await adapter.updateMetrics(this.environment);
      } catch (error) {
        this.logger.error(
          { chain, key: keyToFund.key.address, error },
          'Failed to fund key',
        );
        errors.push(error);
      }
    }

    if (errors.length > 0) {
      throw new Error(
        `Failed to fund keys on chain ${chain}, errors: ${errors.join(', ')}`,
      );
    }
  }
}
