import type { Logger } from 'pino';

import type { ChainMap, ChainName, Token } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import {
  RebalancerStrategyOptions,
  type VelocityFlowStrategy as VelocityFlowStrategyConfig,
} from '../../config/types.js';
import type { Metrics } from '../../metrics/Metrics.js';
import type { IActionTracker } from '../../tracking/IActionTracker.js';
import type { BridgeConfigWithOverride } from '../../utils/bridgeUtils.js';
import { FlowReactiveBaseStrategy } from './FlowReactiveBaseStrategy.js';
import { FLOW_SCALE, type FlowRecord, type FlowSignal } from './types.js';

export class VelocityFlowStrategy extends FlowReactiveBaseStrategy {
  readonly name = RebalancerStrategyOptions.VelocityFlow;

  private readonly config: VelocityFlowStrategyConfig['chains'];
  private readonly velocityMultiplierScaleByChain: Map<ChainName, bigint> =
    new Map();
  private readonly baseResponseScaleByChain: Map<ChainName, bigint> = new Map();

  constructor(
    config: VelocityFlowStrategyConfig['chains'],
    logger: Logger,
    bridgeConfigs: ChainMap<BridgeConfigWithOverride>,
    actionTracker: IActionTracker,
    metrics?: Metrics,
    tokensByChainName?: ChainMap<Token>,
    domainToChainName?: Map<number, ChainName>,
  ) {
    const chains = Object.keys(config);
    assert(
      chains.length > 0,
      'VelocityFlowStrategy requires at least one chain config',
    );

    const log = logger.child({ class: VelocityFlowStrategy.name });
    const chainConfigs = Object.values(config);
    const params = {
      windowSizeMs: Math.max(
        ...chainConfigs.map((c) => c.velocityFlow.windowSizeMs),
      ),
      minSamplesForSignal: Math.min(
        ...chainConfigs.map((c) => c.velocityFlow.minSamplesForSignal),
      ),
      coldStartCycles: Math.max(
        ...chainConfigs.map((c) => c.velocityFlow.coldStartCycles),
      ),
    };

    super(
      chains,
      log,
      bridgeConfigs,
      actionTracker,
      params,
      metrics,
      tokensByChainName,
      domainToChainName,
    );

    this.config = config;
    for (const chain of chains) {
      const { velocityMultiplier, baseResponse } = config[chain].velocityFlow;
      this.velocityMultiplierScaleByChain.set(
        chain,
        BigInt(Math.round(velocityMultiplier * Number(FLOW_SCALE))),
      );
      this.baseResponseScaleByChain.set(
        chain,
        BigInt(Math.round(baseResponse * Number(FLOW_SCALE))),
      );
    }
  }

  computeFlowSignals(flowHistory: Map<ChainName, FlowRecord[]>): FlowSignal[] {
    const signals: FlowSignal[] = [];
    const windowDurationMs = BigInt(this.params.windowSizeMs);

    for (const [chain, records] of flowHistory.entries()) {
      const chainConfig = this.config[chain];
      if (!chainConfig) continue;
      if (records.length < chainConfig.velocityFlow.minSamplesForSignal)
        continue;

      const netFlow = this.getNetFlow(records);
      if (netFlow === 0n) continue;

      const velocityMultiplierScale =
        this.velocityMultiplierScaleByChain.get(chain) ?? 0n;
      const baseResponseScale = this.baseResponseScaleByChain.get(chain) ?? 0n;

      const absNetFlow = netFlow > 0n ? netFlow : -netFlow;

      // Compute a dimensionless urgency factor from flow rate.
      // rateFactor = FLOW_SCALE² / windowDurationMs keeps precision in bigint math.
      // velocityBoost is a scaled additive term on top of baseResponse.
      const rateFactor =
        (FLOW_SCALE * FLOW_SCALE) /
        (windowDurationMs > 0n ? windowDurationMs : 1n);
      const velocityBoost = (velocityMultiplierScale * rateFactor) / FLOW_SCALE;
      const totalResponse = baseResponseScale + velocityBoost;

      // magnitude is linear in absNetFlow, keeping values within on-chain balance range
      const magnitude = (absNetFlow * totalResponse) / FLOW_SCALE;

      if (magnitude === 0n) continue;

      signals.push({
        chain,
        magnitude,
        direction: netFlow > 0n ? 'surplus' : 'deficit',
      });
    }

    return signals;
  }
}
