import { BridgeConfig } from './bridge/BridgeDeploy';
import { CoreConfig } from './core/CoreDeploy';
import { Chain } from './chain';

export interface ExistingDeployConfig {
  chain: Chain;
  coreConfig: CoreConfig;
  bridgeConfig: BridgeConfig;
}