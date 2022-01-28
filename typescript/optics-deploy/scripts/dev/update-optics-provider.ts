import { updateProviderDomain } from '../../src/provider';
import { configPath, networks } from './agentConfig';
import { makeCoreDeploys } from '../../src/core/CoreDeploy';
import { makeBridgeDeploys } from '../../src/bridge/BridgeDeploy';

const coreDeploys = makeCoreDeploys(
  configPath,
  networks,
  (_) => _.chain,
  (_) => _.devConfig,
);
const bridgeDeploys = makeBridgeDeploys(
  configPath,
  networks,
  (_) => _.chain,
  (_) => _.bridgeConfig,
);
updateProviderDomain('dev', coreDeploys, bridgeDeploys);
