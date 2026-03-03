import type { Logger } from 'pino';

import type { ChainMap, ChainName, Token } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import {
  RebalancerStrategyOptions,
  type AccelerationFlowStrategy as AccelerationFlowStrategyConfig,
} from '../../config/types.js';
import type { Metrics } from '../../metrics/Metrics.js';
import type { IActionTracker } from '../../tracking/IActionTracker.js';
import type { BridgeConfigWithOverride } from '../../utils/bridgeUtils.js';
import { FlowReactiveBaseStrategy } from './FlowReactiveBaseStrategy.js';
import { FLOW_SCALE, type FlowRecord, type FlowSignal } from './types.js';

export class AccelerationFlowStrategy extends FlowReactiveBaseStrategy {
  readonly name = RebalancerStrategyOptions.AccelerationFlow;

  private readonly config: AccelerationFlowStrategyConfig['chains'];
  private readonly accelerationWeightScaleByChain: Map<ChainName, bigint> =
    new Map();
  private readonly dampingScaleByChain: Map<ChainName, bigint> = new Map();
  private readonly prevNetFlowByChain: Map<ChainName, bigint> = new Map();

  constructor(
    config: AccelerationFlowStrategyConfig['chains'],
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
      'AccelerationFlowStrategy requires at least one chain config',
    );

    const log = logger.child({ class: AccelerationFlowStrategy.name });
    const chainConfigs = Object.values(config);
    const params = {
      windowSizeMs: Math.max(
        ...chainConfigs.map((c) => c.accelerationFlow.windowSizeMs),
      ),
      minSamplesForSignal: Math.min(
        ...chainConfigs.map((c) => c.accelerationFlow.minSamplesForSignal),
      ),
      coldStartCycles: Math.max(
        ...chainConfigs.map((c) => c.accelerationFlow.coldStartCycles),
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
      const { accelerationWeight, damping } = config[chain].accelerationFlow;
      this.accelerationWeightScaleByChain.set(
        chain,
        BigInt(Math.round(accelerationWeight * Number(FLOW_SCALE))),
      );
      this.dampingScaleByChain.set(
        chain,
        BigInt(Math.round(damping * Number(FLOW_SCALE))),
      );
    }
  }

  computeFlowSignals(flowHistory: Map<ChainName, FlowRecord[]>): FlowSignal[] {
    const signals: FlowSignal[] = [];

    for (const [chain, records] of flowHistory.entries()) {
      const chainConfig = this.config[chain];
      if (!chainConfig) continue;
      if (records.length < chainConfig.accelerationFlow.minSamplesForSignal)
        continue;

      const currentNetFlow = this.getNetFlow(records);
      const prevNetFlow = this.prevNetFlowByChain.get(chain) ?? 0n;
      const acceleration = currentNetFlow - prevNetFlow;

      this.prevNetFlowByChain.set(chain, currentNetFlow);

      if (currentNetFlow === 0n && acceleration === 0n) continue;

      const absCurrentNetFlow =
        currentNetFlow > 0n ? currentNetFlow : -currentNetFlow;
      const absAcceleration = acceleration > 0n ? acceleration : -acceleration;
      const dampingScale = this.dampingScaleByChain.get(chain) ?? 0n;
      const accelerationWeightScale =
        this.accelerationWeightScaleByChain.get(chain) ?? 0n;

      const dampedComponent = (absCurrentNetFlow * dampingScale) / FLOW_SCALE;
      const accelerationComponent =
        (absAcceleration * accelerationWeightScale) / FLOW_SCALE;
      const magnitude = dampedComponent + accelerationComponent;

      let direction: 'surplus' | 'deficit';
      if (currentNetFlow > 0n) {
        direction = 'surplus';
      } else if (currentNetFlow < 0n) {
        direction = 'deficit';
      } else if (acceleration > 0n) {
        direction = 'surplus';
      } else {
        direction = 'deficit';
      }

      signals.push({ chain, magnitude, direction });
    }

    return signals;
  }
}
