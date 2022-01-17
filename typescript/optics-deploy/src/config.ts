import { BridgeConfig } from './bridge/BridgeDeploy';
import { CoreConfig } from './core/CoreDeploy';
import { Chain } from './chain';

export interface AllConfigs {
  chain: Chain;
  coreConfig: CoreConfig;
  bridgeConfig: BridgeConfig;
}

// The accessor is necessary as a network may have multiple core configs
export function makeAllConfigs<V>(data: V, coreConfigAccessor: (data: V) => CoreConfig) {
  return { ...data, coreConfig: coreConfigAccessor(data) };
}
