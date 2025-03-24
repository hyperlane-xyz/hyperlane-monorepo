import {
  HyperToken__factory,
  IVaultTokenized__factory,
  ProxyAdmin__factory,
} from '@hyperlane-xyz/core';
import {
  configureAccess,
  proxyAdmin as fetchProxyAdmin,
} from '@hyperlane-xyz/sdk';

import { Contexts } from '../config/contexts.js';
import accessManagerConfig from '../config/environments/testnet4/accessmanager.js';
import { ETHEREUM_DEPLOYER_ADDRESS } from '../config/environments/testnet4/owners.js';
import { Role } from '../src/roles.js';

import { getArgs, withChains, withContext } from './agent-utils.js';
import { getEnvironmentConfig } from './core-utils.js';

const HYPER_TOKEN_SEPOLIA = '0x1e111DF35aD11B3d18e5b5E9A7fd4Ed8dc841011';
const VAULT = '0xF56179944D867469612D138c74F1dE979D3faC72';
const INITIAL_ADMIN = ETHEREUM_DEPLOYER_ADDRESS;

async function main() {
  const {
    context = Contexts.Hyperlane,
    environment,
    chains,
  } = await withContext(withChains(getArgs())).argv;
  const envConfig = getEnvironmentConfig(environment);

  const multiProvider = await envConfig.getMultiProvider(
    context,
    Role.Deployer,
    true,
    chains,
  );

  const provider = multiProvider.getProvider('sepolia');

  const hyperToken = HyperToken__factory.connect(HYPER_TOKEN_SEPOLIA, provider);

  const proxyAdminAddress = await fetchProxyAdmin(
    provider,
    '0x1e111DF35aD11B3d18e5b5E9A7fd4Ed8dc841011',
  );

  const proxyAdmin = ProxyAdmin__factory.connect(proxyAdminAddress, provider);

  const vault = IVaultTokenized__factory.connect(VAULT, provider);

  const contracts = {
    hyperToken,
    proxyAdmin,
    vault,
  };

  const reconfigureData = configureAccess(
    contracts,
    accessManagerConfig,
    INITIAL_ADMIN,
  );

  console.dir(reconfigureData);
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
