import { BridgeConfig } from './bridge/BridgeDeploy';
import { CoreConfig } from './core/CoreDeploy';
import { Chain } from './chain';

export interface ExistingDeployConfig {
  chain: Chain;
  coreConfig: CoreConfig;
  bridgeConfig: BridgeConfig;
}

export function makeExistingDeployConfig<V>(data: V, coreConfigAccessor: (data: V) => CoreConfig) {
  return { ...data, coreConfig: coreConfigAccessor(data) };
}
