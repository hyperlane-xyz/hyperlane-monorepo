import type { Logger } from 'pino';

import type { ChainMap, ChainName, Token } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import {
  RebalancerStrategyOptions,
  type EMAFlowStrategy as EMAFlowStrategyConfig,
} from '../../config/types.js';
import type { Metrics } from '../../metrics/Metrics.js';
import type { IActionTracker } from '../../tracking/IActionTracker.js';
import type { BridgeConfigWithOverride } from '../../utils/bridgeUtils.js';
import { FlowReactiveBaseStrategy } from './FlowReactiveBaseStrategy.js';
import { FLOW_SCALE, type FlowRecord, type FlowSignal } from './types.js';

export class EMAFlowStrategy extends FlowReactiveBaseStrategy {
  readonly name = RebalancerStrategyOptions.EMAFlow;
  private readonly config: EMAFlowStrategyConfig['chains'];
  private readonly alphaScaleByChain: Map<ChainName, bigint> = new Map();
  private readonly emaByChain: Map<ChainName, bigint> = new Map();

  constructor(
    config: EMAFlowStrategyConfig['chains'],
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
      'EMAFlowStrategy requires at least one chain config',
    );

    const log = logger.child({ class: EMAFlowStrategy.name });
    const chainConfigs = Object.values(config);
    const params = {
      windowSizeMs: Math.max(
        ...chainConfigs.map((c) => c.emaFlow.windowSizeMs),
      ),
      minSamplesForSignal: Math.min(
        ...chainConfigs.map((c) => c.emaFlow.minSamplesForSignal),
      ),
      coldStartCycles: Math.max(
        ...chainConfigs.map((c) => c.emaFlow.coldStartCycles),
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
      const alpha = config[chain].emaFlow.alpha;
      const alphaScale = BigInt(Math.round(alpha * Number(FLOW_SCALE)));
      this.alphaScaleByChain.set(chain, alphaScale);
      this.emaByChain.set(chain, 0n);
    }
  }

  computeFlowSignals(flowHistory: Map<ChainName, FlowRecord[]>): FlowSignal[] {
    const signals: FlowSignal[] = [];

    for (const [chain, records] of flowHistory.entries()) {
      const chainConfig = this.config[chain];
      if (!chainConfig) continue;
      if (records.length < chainConfig.emaFlow.minSamplesForSignal) continue;

      const netFlow = this.getNetFlow(records);
      const alphaScale = this.alphaScaleByChain.get(chain) ?? 0n;
      const prevEma = this.emaByChain.get(chain) ?? 0n;
      const ema =
        (alphaScale * netFlow + (FLOW_SCALE - alphaScale) * prevEma) /
        FLOW_SCALE;

      this.emaByChain.set(chain, ema);

      if (ema > 0n) {
        signals.push({ chain, magnitude: ema, direction: 'surplus' });
      } else if (ema < 0n) {
        signals.push({ chain, magnitude: -ema, direction: 'deficit' });
      }
    }

    return signals;
  }
}
