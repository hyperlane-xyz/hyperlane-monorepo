import { Contexts } from '../../config/contexts.js';
import { ETHEREUM_DEPLOYER_ADDRESS } from '../../config/environments/testnet4/owners.js';
import { Role } from '../../src/roles.js';
import { SymbioticChecker } from '../../src/symbiotic/HyperlaneSymbioticChecker.js';
import { getArgs, withContext } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

// TODO: this is a temporary, will define this in a config file
const config = {
  chain: 'sepolia',
  // network: {
  //   address: '0x0000000000000000000000000000000000000000',
  // },
  accessManager: {
    address: ETHEREUM_DEPLOYER_ADDRESS,
  },
  collateral: {
    address: '0x1e111DF35aD11B3d18e5b5E9A7fd4Ed8dc841011',
  },
  vault: {
    address: '0xF56179944D867469612D138c74F1dE979D3faC72',
    epochDuration: 604800,
  },
  slasher: {
    address: '0x2cB6a0B85A1c6a1d293EA9541d0E7425cA950B46',
  },
  delegator: {
    address: '0x597E165bB91254723Df1A61dDF6AD814267c6D9C',
  },
  burner: {
    address: '0x7a3527cd4Ae873bE48581cA52a46574488C04cDe',
  },
  // rewards: {
  //   address: '0x0000000000000000000000000000000000000000',
  // },
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

  const checker = new SymbioticChecker(multiProvider, config);
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
