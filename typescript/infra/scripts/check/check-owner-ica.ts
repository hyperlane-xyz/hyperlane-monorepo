import { AccountConfig, InterchainAccount } from '@hyperlane-xyz/sdk';
import {
  Address,
  LogFormat,
  LogLevel,
  configureRootLogger,
  eqAddress,
  isZeroishAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

import {
  getGovernanceIcas,
  getGovernanceSafes,
} from '../../config/environments/mainnet3/governance/utils.js';
import { chainsToSkip } from '../../src/config/chain.js';
import { withGovernanceType } from '../../src/governance.js';
import { isEthereumProtocolChain } from '../../src/utils/utils.js';
import { getArgs as getEnvArgs, withChains } from '../agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../core-utils.js';

function getArgs() {
  return withGovernanceType(withChains(getEnvArgs())).option('ownerChain', {
    type: 'string',
    description: 'Origin chain where the Safe owner lives',
    default: 'ethereum',
  }).argv;
}

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);

  const { environment, ownerChain, chains, governanceType } = await getArgs();
  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  const owner = getGovernanceSafes(governanceType)[ownerChain];
  if (!owner) {
    rootLogger.error(`No Safe owner found for ${ownerChain}`);
    process.exit(1);
  }

  rootLogger.info(`Safe owner on ${ownerChain}: ${owner}`);

  const { chainAddresses } = await getHyperlaneCore(environment, multiProvider);
  const interchainAccountApp = InterchainAccount.fromAddressesMap(
    chainAddresses,
    multiProvider,
  );

  const icas = getGovernanceIcas(governanceType);

  const checkOwnerIcaChains = (
    chains?.length ? chains : Object.keys(icas)
  ).filter(
    (chain) => isEthereumProtocolChain(chain) && !chainsToSkip.includes(chain),
  );

  const ownerConfig: AccountConfig = {
    origin: ownerChain,
    owner: owner,
  };
  const ownerChainInterchainAccountRouter =
    interchainAccountApp.contractsMap[ownerChain].interchainAccountRouter
      .address;

  if (isZeroishAddress(ownerChainInterchainAccountRouter)) {
    rootLogger.error(`Interchain account router address is zero`);
    process.exit(1);
  }

  const mismatchedResults: Record<
    string,
    { Expected: Address; Actual: Address }
  > = {};
  for (const chain of checkOwnerIcaChains) {
    const expectedAddress = icas[chain];
    if (!expectedAddress) {
      rootLogger.error(`No expected address found for ${chain}`);
      continue;
    }
    const actualAccount = await interchainAccountApp.getAccount(
      chain,
      ownerConfig,
      ownerChainInterchainAccountRouter,
    );
    if (!eqAddress(expectedAddress, actualAccount)) {
      mismatchedResults[chain] = {
        Expected: expectedAddress,
        Actual: actualAccount,
      };
    }
  }

  if (Object.keys(mismatchedResults).length > 0) {
    rootLogger.error('\nMismatched ICAs found:');
    // eslint-disable-next-line no-console
    console.table(mismatchedResults);
    process.exit(1);
  } else {
    rootLogger.info('✅ All ICAs match the expected addresses.');
  }
  process.exit(0);
}

main().catch((err) => {
  rootLogger.error('Error:', err);
  process.exit(1);
});
