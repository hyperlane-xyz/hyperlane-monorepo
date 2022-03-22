export { AbacusBridge } from './app';
export { BridgeContractAddresses, BridgeContracts } from './contracts';
export {
  AnnotatedSend,
  AnnotatedTokenDeployed,
  SendArgs,
  SendTypes,
  SendEvent,
  TokenDeployedArgs,
  TokenDeployedTypes,
  TokenDeployedEvent,
} from './events';

import { AbacusBridge } from './app';
import { test } from './environments';
export const bridges: Record<any, AbacusBridge> = {
  test: new AbacusBridge(test),
};
