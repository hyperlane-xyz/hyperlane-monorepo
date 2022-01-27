import * as celo from '../../config/mainnets/celo';
import * as ethereum from '../../config/mainnets/ethereum';
import * as polygon from '../../config/mainnets/polygon';
import { updateProviderDomain } from '../../src/provider';
import { makeCoreDeploys } from '../../src/core/CoreDeploy';
import { makeBridgeDeploys } from '../../src/bridge/BridgeDeploy';

const configPath = '../../rust/config/mainnet';
const networks = [ethereum, polygon, celo];
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
