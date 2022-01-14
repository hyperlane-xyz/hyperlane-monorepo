import { BridgeConfig } from './bridge/BridgeDeploy';
import { CoreConfig } from './core/CoreDeploy';
import { Chain } from './chain';

export interface AllConfigs {
  chain: Chain;
  coreConfig: CoreConfig;
  bridgeConfig: BridgeConfig;
}

export function makeAllConfigs<V>(data: V, coreConfigAccessor: (data: V) => CoreConfig) {
  return { ...data, coreConfig: coreConfigAccessor(data) };
}
