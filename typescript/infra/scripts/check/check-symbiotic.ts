import {
  AccessControl__factory,
  ICompoundStakerRewards__factory,
  IVaultTokenized__factory,
  TimelockController__factory,
} from '@hyperlane-xyz/core';

import { Contexts } from '../../config/contexts.js';
import {
  COLLATERAL_CHAIN,
  COMPOUND_STAKING_REWARDS,
  OWNERS,
} from '../../config/environments/mainnet3/warp/configGetters/getHyperWarpConfig.js';
import { DeployEnvironment } from '../../src/config/environment.js';
import { Role } from '../../src/roles.js';
import {
  SymbioticAddresses,
  SymbioticChecker,
  SymbioticConfig,
  SymbioticContracts,
} from '../../src/symbiotic/HyperlaneSymbioticChecker.js';
import { getArgs, withContext } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

const mainnet3Addresses = {
  accessManager: OWNERS[COLLATERAL_CHAIN],
  vault: '',
  network: '',
  compoundStakerRewards: COMPOUND_STAKING_REWARDS,
};

const mainnet3Config: SymbioticConfig = {
  chain: COLLATERAL_CHAIN,
  vault: {
    epochDuration: 604800,
  },
  rewards: {
    adminFee: 0,
  },
  burner: {
    owner: mainnet3Addresses.accessManager,
  },
  // delegator: {
  //   networkLimit;
  //   operatorNetworkShares;
  // };,
};

const testnet4Addresses = {
  accessManager: '0xfad1c94469700833717fa8a3017278bc1ca8031c',
  vault: '0xF56179944D867469612D138c74F1dE979D3faC72',
  network: '0x44ea7acf8785d9274047e05c249ba80f7ff79d36',
  compoundStakerRewards: '0x2aDe4CDD4DCECD4FdE76dfa99d61bC8c1940f2CE',
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
  // delegator: {
  //   networkLimit;
  //   operatorNetworkShares;
  // };,
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
  const { context = Contexts.Hyperlane, environment } = await withContext(
    getArgs(),
  ).argv;
  const envConfig = getEnvironmentConfig(environment);

  const [config, addresses] = getConfig(environment);

  const multiProvider = await envConfig.getMultiProvider(
    context,
    Role.Deployer,
    true,
    [config.chain],
  );

  const provider = multiProvider.getProvider(config.chain);

  const contracts: SymbioticContracts = {
    compoundStakerRewards: ICompoundStakerRewards__factory.connect(
      addresses.compoundStakerRewards,
      provider,
    ),
    network: TimelockController__factory.connect(addresses.network, provider),
    accessManager: AccessControl__factory.connect(
      addresses.accessManager,
      provider,
    ),
    vault: IVaultTokenized__factory.connect(addresses.vault, provider),
  };

  const checker = new SymbioticChecker(multiProvider, config, contracts);
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
