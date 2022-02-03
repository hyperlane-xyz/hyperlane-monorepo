import { updateProviderDomain } from '../../src/provider';
import { makeCoreDeploys } from '../../src/core/CoreDeploy';
import { makeBridgeDeploys } from '../../src/bridge/BridgeDeploy';
import { configPath, networks } from './agentConfig';

const coreDeploys = makeCoreDeploys(
  configPath,
  networks,
  (_) => _.chain,
  (_) => _.config,
);
const bridgeDeploys = makeBridgeDeploys(
  configPath,
  networks,
  (_) => _.chain,
  (_) => _.bridgeConfig,
);
updateProviderDomain('mainnet', coreDeploys, bridgeDeploys);
