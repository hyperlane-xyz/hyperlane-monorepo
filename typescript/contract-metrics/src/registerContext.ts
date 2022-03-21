import {
  AbacusCore,
  AbacusBridge,
  AbacusGovernance,
  ChainName,
  localCore,
  localBridge,
  localGovernance,
} from '@abacus-network/sdk';
import config from './config';

// register local
type Rpc = {
  chain: ChainName;
  rpc: string;
};
const rpcs: Rpc[] = [
  { chain: 'celo', rpc: config.celoRpc },
  { chain: 'ethereum', rpc: config.ethereumRpc },
  { chain: 'polygon', rpc: config.polygonRpc },
];
rpcs.map((rpc) => {
  localCore.registerRpcProvider(rpc.chain, rpc.rpc);
  localBridge.registerRpcProvider(rpc.chain, rpc.rpc);
  localGovernance.registerRpcProvider(rpc.chain, rpc.rpc);
});

let core: AbacusCore;
let bridge: AbacusBridge;
let governance: AbacusGovernance;
switch (config.environment) {
  case 'local':
    core = localCore;
    bridge = localBridge;
    governance = localGovernance;
    break;

  default:
    throw new Error('Unrecognized environment');
    break;
}

export { core, bridge, governance };
