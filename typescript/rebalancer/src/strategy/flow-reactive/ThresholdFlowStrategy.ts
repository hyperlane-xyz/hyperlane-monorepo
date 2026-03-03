import type { Logger } from 'pino';

import type { ChainMap, ChainName, Token } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import {
  RebalancerStrategyOptions,
  type ThresholdFlowStrategy as ThresholdFlowStrategyConfig,
} from '../../config/types.js';
import type { Metrics } from '../../metrics/Metrics.js';
import type { IActionTracker } from '../../tracking/IActionTracker.js';
import type { BridgeConfigWithOverride } from '../../utils/bridgeUtils.js';
import { FlowReactiveBaseStrategy } from './FlowReactiveBaseStrategy.js';
import { FLOW_SCALE, type FlowRecord, type FlowSignal } from './types.js';

export class ThresholdFlowStrategy extends FlowReactiveBaseStrategy {
  readonly name = RebalancerStrategyOptions.ThresholdFlow;

  private readonly config: ThresholdFlowStrategyConfig['chains'];
  private readonly noiseThresholdScaleByChain: Map<ChainName, bigint> =
    new Map();
  private readonly proportionalGainScaleByChain: Map<ChainName, bigint> =
    new Map();

  constructor(
    config: ThresholdFlowStrategyConfig['chains'],
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
      'ThresholdFlowStrategy requires at least one chain config',
    );

    const log = logger.child({ class: ThresholdFlowStrategy.name });
    const chainConfigs = Object.values(config);
    const params = {
      windowSizeMs: Math.max(
        ...chainConfigs.map((c) => c.thresholdFlow.windowSizeMs),
      ),
      minSamplesForSignal: Math.min(
        ...chainConfigs.map((c) => c.thresholdFlow.minSamplesForSignal),
      ),
      coldStartCycles: Math.max(
        ...chainConfigs.map((c) => c.thresholdFlow.coldStartCycles),
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
      const { noiseThreshold, proportionalGain } = config[chain].thresholdFlow;
      this.noiseThresholdScaleByChain.set(
        chain,
        BigInt(Math.round(noiseThreshold * Number(FLOW_SCALE))),
      );
      this.proportionalGainScaleByChain.set(
        chain,
        BigInt(Math.round(proportionalGain * Number(FLOW_SCALE))),
      );
    }
  }

  computeFlowSignals(flowHistory: Map<ChainName, FlowRecord[]>): FlowSignal[] {
    const signals: FlowSignal[] = [];

    for (const [chain, records] of flowHistory.entries()) {
      const chainConfig = this.config[chain];
      if (!chainConfig) continue;
      if (records.length < chainConfig.thresholdFlow.minSamplesForSignal)
        continue;

      const netFlow = this.getNetFlow(records);
      const absNetFlow = netFlow > 0n ? netFlow : -netFlow;
      const noiseThresholdScale =
        this.noiseThresholdScaleByChain.get(chain) ?? 0n;
      if (absNetFlow <= noiseThresholdScale) continue;

      const excess = absNetFlow - noiseThresholdScale;
      const proportionalGainScale =
        this.proportionalGainScaleByChain.get(chain) ?? 0n;
      const magnitude = (excess * proportionalGainScale) / FLOW_SCALE;

      signals.push({
        chain,
        magnitude,
        direction: netFlow > 0n ? 'surplus' : 'deficit',
      });
    }

    return signals;
  }
}
