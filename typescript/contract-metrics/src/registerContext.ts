import {
  AbacusCore,
  AbacusBridge,
  AbacusGovernance,
  ChainName,
  bridgeAddresses,
  coreAddresses,
  governanceAddresses,
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

const environment = config.environment;
const core = new AbacusCore(coreAddresses[environment]);
const bridge = new AbacusBridge(bridgeAddresses[environment]);
const governance = new AbacusGovernance(governanceAddresses[environment]);

rpcs.map((rpc) => {
  core.registerRpcProvider(rpc.chain, rpc.rpc);
  bridge.registerRpcProvider(rpc.chain, rpc.rpc);
  governance.registerRpcProvider(rpc.chain, rpc.rpc);
});

export { core, bridge, governance };
