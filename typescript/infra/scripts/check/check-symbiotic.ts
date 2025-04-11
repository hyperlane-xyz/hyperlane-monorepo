import { ethers } from 'ethers';

import {
  AccessControl__factory,
  ICompoundStakerRewards__factory,
  TimelockController__factory,
} from '@hyperlane-xyz/core';

import { Contexts } from '../../config/contexts.js';
import { NETWORK } from '../../config/environments/mainnet3/symbiotic.js';
import {
  COLLATERAL_CHAIN,
  OWNERS,
} from '../../config/environments/mainnet3/warp/configGetters/getHyperWarpConfig.js';
import { getWarpCoreConfig } from '../../config/registry.js';
import { DeployEnvironment } from '../../src/config/environment.js';
import { Role } from '../../src/roles.js';
import {
  SymbioticAddresses,
  SymbioticChecker,
  SymbioticConfig,
  SymbioticContracts,
} from '../../src/symbiotic/HyperlaneSymbioticChecker.js';
import {
  getArgs,
  withContext,
  withWarpRouteIdRequired,
} from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

const mainnet3Addresses = {
  accessManager: OWNERS[COLLATERAL_CHAIN],
  network: NETWORK,
};

const thirtyDays = 60 * 60 * 24 * 30;

const mainnet3Config: SymbioticConfig = {
  chain: COLLATERAL_CHAIN,
  vault: {
    epochDuration: thirtyDays,
  },
  rewards: {
    adminFee: 0,
  },
  burner: {
    owner: mainnet3Addresses.accessManager,
  },
  delegator: {
    hook: ethers.constants.AddressZero,
    // networkLimit;
    // operatorNetworkShares;
  },
};

const testnet4Addresses = {
  accessManager: '0xfad1c94469700833717fa8a3017278bc1ca8031c',
  network: '0x44ea7acf8785d9274047e05c249ba80f7ff79d36',
};

const testnet4Config: SymbioticConfig = {
  chain: 'sepolia',
  vault: {
    epochDuration: 604800,
  },
  rewards: {
    adminFee: 0,
  },
  burner: {
    owner: testnet4Addresses.accessManager,
  },
  delegator: {
    hook: ethers.constants.AddressZero,
    // networkLimit;
    // operatorNetworkShares;
  },
};

function getConfig(
  environment: DeployEnvironment,
): [SymbioticConfig, SymbioticAddresses] {
  switch (environment) {
    case 'mainnet3':
      return [mainnet3Config, mainnet3Addresses];
    case 'testnet4':
      return [testnet4Config, testnet4Addresses];
    default:
      throw new Error(`Unsupported environment: ${environment}`);
  }
}
async function main() {
  const {
    context = Contexts.Hyperlane,
    environment,
    warpRouteId,
  } = await withWarpRouteIdRequired(withContext(getArgs())).argv;
  const envConfig = getEnvironmentConfig(environment);

  const warpCoreConfig = getWarpCoreConfig(warpRouteId);

  const [symbioticConfig, symbioticAddresses] = getConfig(environment);

  const compoundStakerRewards = warpCoreConfig.tokens.find(
    (token) => token.chainName === symbioticConfig.chain,
  )?.collateralAddressOrDenom;

  if (!compoundStakerRewards) {
    throw new Error(
      `Compound staker rewards not found for ${symbioticConfig.chain}`,
    );
  }

  const multiProvider = await envConfig.getMultiProvider(
    context,
    Role.Deployer,
    true,
    [symbioticConfig.chain],
  );

  const provider = multiProvider.getProvider(symbioticConfig.chain);

  const contracts: SymbioticContracts = {
    compoundStakerRewards: ICompoundStakerRewards__factory.connect(
      compoundStakerRewards,
      provider,
    ),
    network: TimelockController__factory.connect(
      symbioticAddresses.network,
      provider,
    ),
    accessManager: AccessControl__factory.connect(
      symbioticAddresses.accessManager,
      provider,
    ),
  };

  const checker = new SymbioticChecker(
    multiProvider,
    symbioticConfig,
    contracts,
  );
  await checker.check();
  checker.logViolationsTable();
  checker.expectEmpty();
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
