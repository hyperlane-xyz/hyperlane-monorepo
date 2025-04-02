import { Contexts } from '../../config/contexts.js';
import { Role } from '../../src/roles.js';
import { SymbioticChecker } from '../../src/symbiotic/HyperlaneSymbioticChecker.js';
import { getArgs, withContext } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

// TODO:
// rewards contract address is wrong?
// delegator subnetwork checks

// STAGING DEPLOYMENT Addresses
const ACCESS_MANAGER = '0xfad1c94469700833717fa8a3017278bc1ca8031c';
const VAULT = '0xF56179944D867469612D138c74F1dE979D3faC72';
const NETWORK = '0x44ea7acf8785d9274047e05c249ba80f7ff79d36';
const REWARDS = '0x2aDe4CDD4DCECD4FdE76dfa99d61bC8c1940f2CE'; // don't think this is the correct address for the staging deployment

// TODO: will replace this hardcoded config with the actual config based on the environment
// hardcoded staging config
const config = {
  chain: 'sepolia',
  network: {
    address: NETWORK,
  },
  accessManager: {
    address: ACCESS_MANAGER,
  },
  vault: {
    address: VAULT,
    epochDuration: 604800,
  },
  rewards: {
    address: REWARDS,
    adminFee: 1000000, // dummy value
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

  const derivedContractAddresses =
    await SymbioticChecker.deriveContractAddresses(
      config.chain,
      multiProvider,
      config.vault.address,
    );

  const checker = new SymbioticChecker(
    multiProvider,
    config,
    derivedContractAddresses,
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
