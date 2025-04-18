import {
  HypERC4626Collateral__factory,
  HyperToken__factory,
  ICompoundStakerRewards__factory,
  IVaultTokenized__factory,
  InterchainAccountRouter__factory,
  ProxyAdmin__factory,
  TimelockController__factory,
} from '@hyperlane-xyz/core';
import {
  configureAccess,
  proxyAdmin as fetchProxyAdmin,
} from '@hyperlane-xyz/sdk';

import { Contexts } from '../config/contexts.js';
import accessManagerConfig, {
  ManagedContracts,
} from '../config/environments/mainnet3/accessmanager.js';
import { NETWORK } from '../config/environments/mainnet3/symbiotic.js';
import { COLLATERAL_CHAIN } from '../config/environments/mainnet3/warp/configGetters/getHyperWarpConfig.js';
import { WarpRouteIds } from '../config/environments/mainnet3/warp/warpIds.js';
import { getMainnetAddresses, getWarpCoreConfig } from '../config/registry.js';
import { Role } from '../src/roles.js';

import { getArgs, withChains, withContext } from './agent-utils.js';
import { getEnvironmentConfig } from './core-utils.js';

const INITIAL_ADMIN = '0x79fa1F70fBBA4Dd07510B21b32525b602FaDf31c';

async function main() {
  const {
    context = Contexts.Hyperlane,
    environment,
    chains,
  } = await withContext(withChains(getArgs())).argv;

  const hyperConfig = getWarpCoreConfig(WarpRouteIds.Hyper);
  const hyperTokenAddress = hyperConfig.tokens.find(
    (token) => token.chainName === COLLATERAL_CHAIN,
  )?.addressOrDenom;

  const stakedHyperConfig = getWarpCoreConfig(WarpRouteIds.StakedHyper);
  const stakedHyperWarpRouteAddress = stakedHyperConfig.tokens.find(
    (token) => token.chainName === COLLATERAL_CHAIN,
  )?.addressOrDenom;
  const compoundStakerRewards = stakedHyperConfig.tokens.find(
    (token) => token.chainName === COLLATERAL_CHAIN,
  )?.collateralAddressOrDenom;

  if (
    !stakedHyperWarpRouteAddress ||
    !hyperTokenAddress ||
    !compoundStakerRewards
  ) {
    throw new Error(`Missing token addresses for ${COLLATERAL_CHAIN}`);
  }

  const envConfig = getEnvironmentConfig(environment);

  const multiProvider = await envConfig.getMultiProvider(
    context,
    Role.Deployer,
    true,
    chains,
  );

  const provider = multiProvider.getProvider(COLLATERAL_CHAIN);

  const hyperToken = HyperToken__factory.connect(hyperTokenAddress, provider);
  const hyperProxyAdminAddress = await fetchProxyAdmin(
    provider,
    hyperTokenAddress,
  );
  const hyperProxyAdmin = ProxyAdmin__factory.connect(
    hyperProxyAdminAddress,
    provider,
  );

  const stakedHyperWarpRoute = HypERC4626Collateral__factory.connect(
    stakedHyperWarpRouteAddress,
    provider,
  );
  const stakedHyperProxyAdminAddress = await fetchProxyAdmin(
    provider,
    stakedHyperWarpRouteAddress,
  );
  const stakedHyperProxyAdmin = ProxyAdmin__factory.connect(
    stakedHyperProxyAdminAddress,
    provider,
  );

  const network = TimelockController__factory.connect(NETWORK, provider);

  const icaRouterAddress =
    getMainnetAddresses()[COLLATERAL_CHAIN].interchainAccountRouter;
  const interchainAccountRouter = InterchainAccountRouter__factory.connect(
    icaRouterAddress,
    provider,
  );

  const vaultAddress = await ICompoundStakerRewards__factory.connect(
    compoundStakerRewards,
    provider,
  ).vault();
  const vault = IVaultTokenized__factory.connect(vaultAddress, provider);

  const contracts: ManagedContracts = {
    hyperToken,
    stakedHyperWarpRoute,
    hyperProxyAdmin,
    stakedHyperProxyAdmin,
    vault,
    network,
    interchainAccountRouter,
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
