import {
  AccessControl__factory,
  ICompoundStakerRewards__factory,
  IVaultTokenized__factory,
  TimelockController__factory,
} from '@hyperlane-xyz/core';

import { Contexts } from '../../config/contexts.js';
import { Role } from '../../src/roles.js';
import {
  SymbioticChecker,
  SymbioticConfig,
  SymbioticContracts,
} from '../../src/symbiotic/HyperlaneSymbioticChecker.js';
import { getArgs, withContext } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

// TODO:
// delegator subnetwork checks

// STAGING DEPLOYMENT Addresses
const ACCESS_MANAGER = '0xfad1c94469700833717fa8a3017278bc1ca8031c';
const VAULT = '0xF56179944D867469612D138c74F1dE979D3faC72';
const NETWORK = '0x44ea7acf8785d9274047e05c249ba80f7ff79d36';
const COMPOUND_STAKER_REWARDS = '0x2aDe4CDD4DCECD4FdE76dfa99d61bC8c1940f2CE';

// TODO: will replace this hardcoded config with the actual config based on the environment
// hardcoded staging config
const config: SymbioticConfig = {
  chain: 'sepolia',
  vault: {
    epochDuration: 604800,
  },
  rewards: {
    adminFee: 0,
  },
  burner: {
    owner: ACCESS_MANAGER,
  },
  // delegator: {
  //   networkLimit;
  //   operatorNetworkShares;
  // };,
};

async function main() {
  const { context = Contexts.Hyperlane, environment } = await withContext(
    getArgs(),
  ).argv;
  const envConfig = getEnvironmentConfig(environment);

  const multiProvider = await envConfig.getMultiProvider(
    context,
    Role.Deployer,
    true,
    [config.chain],
  );

  const provider = multiProvider.getProvider(config.chain);

  const contracts: SymbioticContracts = {
    compoundStakerRewards: ICompoundStakerRewards__factory.connect(
      COMPOUND_STAKER_REWARDS,
      provider,
    ),
    network: TimelockController__factory.connect(NETWORK, provider),
    accessManager: AccessControl__factory.connect(ACCESS_MANAGER, provider),
    vault: IVaultTokenized__factory.connect(VAULT, provider),
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
