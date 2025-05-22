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
import { ChainFundingPlan, FunderAddresses, FunderConfig } from './types.js';

/**
 * MultiProtocolFundingApp is a class that extends MultiProtocolApp and provides a funding interface for the app
 * It is responsible for funding keys and claiming from IGP for a given context on a given environment
 * It is also responsible for timing out the funding process if it takes too long
 */
export class MultiProtocolFundingApp extends MultiProtocolApp<
  IFundingAdapter,
  FunderAddresses
> {
  public readonly logger: Logger;

  constructor(
    private readonly multiProtocolProvider: MultiProtocolProvider,
    public readonly addresses: ChainMap<FunderAddresses>,
    private readonly environment: DeployEnvironment,
    private readonly context: Contexts,
    private readonly config: FunderConfig,
    private readonly walletBalanceGauge: Gauge<string>,
    logger: Logger = rootLogger.child({ module: 'multi-protocol-funding-app' }),
  ) {
    super(multiProtocolProvider, addresses, logger);
    this.logger = logger;
  }

  /**
   * Returns the adapter for the given protocol
   * @param protocol - The protocol to get the adapter for
   * @returns The adapter for the given protocol
   */
  override protocolToAdapter(
    protocol: ProtocolType,
  ): AdapterClassType<IFundingAdapter> {
    if (protocol === ProtocolType.Ethereum) return EVMFundingAdapter;
    if (protocol === ProtocolType.Sealevel) return SealevelFundingAdapter;
    throw new Error(`No adapter for protocol ${protocol}`);
  }

  /**
   * Returns the adapter for the given chain
   * @param chain - The chain to get the adapter for
   * @returns The adapter for the given chain
   */
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

  /**
   * Funds the keys for the given chain and funding plan, also handles IGP claims
   * @param chain - The chain to fund the keys for
   * @param fundingPlan - The funding plan for the given chain
   * @returns void
   */
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
