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
export const bridge = {
  test: new AbacusBridge(test),
};
