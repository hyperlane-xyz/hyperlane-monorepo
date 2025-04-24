import {
  EthersAdapter,
  SafeAccountConfig,
  SafeFactory,
} from '@safe-global/protocol-kit';
import { ethers } from 'ethers';

import { rootLogger } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { getGovernanceSigners } from '../../config/environments/mainnet3/governance/utils.js';
import { withGovernanceType } from '../../src/governance.js';
import { Role } from '../../src/roles.js';
import {
  getArgs,
  withChainRequired,
  withSafeHomeUrlRequired,
  withThreshold,
} from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

async function main() {
  const { chain, safeHomeUrl, threshold, governanceType } =
    await withGovernanceType(
      withThreshold(withSafeHomeUrlRequired(withChainRequired(getArgs()))),
    ).argv;

  const envConfig = getEnvironmentConfig('mainnet3');
  const multiProvider = await envConfig.getMultiProvider(
    Contexts.Hyperlane,
    Role.Deployer,
    true,
    [chain],
  );

  const signer = multiProvider.getSigner(chain);
  const ethAdapter = new EthersAdapter({
    ethers,
    signerOrProvider: signer,
  });

  let safeFactory;
  try {
    safeFactory = await SafeFactory.create({
      ethAdapter,
    });
  } catch (e) {
    rootLogger.error(`Error initializing SafeFactory: ${e}`);
    process.exit(1);
  }

  const { signers, threshold: defaultThreshold } =
    getGovernanceSigners(governanceType);
  const safeAccountConfig: SafeAccountConfig = {
    owners: signers,
    threshold: threshold ?? defaultThreshold,
  };

  let safe;
  try {
    safe = await safeFactory.deploySafe({ safeAccountConfig });
  } catch (e) {
    rootLogger.error(`Error deploying Safe: ${e}`);
    process.exit(1);
  }

  const safeAddress = await safe.getAddress();

  rootLogger.info(`Safe address: ${safeAddress}`);
  rootLogger.info(`Safe url: ${safeHomeUrl}/home?safe=${chain}:${safeAddress}`);
  rootLogger.info('url may not be correct, please check by following the link');

  try {
    // TODO: check https://app.safe.global for officially supported chains, filter by chain id
    const chainsUrl = `${safeHomeUrl.replace(
      'https://',
      'https://gateway.',
    )}/v1/chains`;
    rootLogger.info(`Fetching chain data from ${chainsUrl}`);
    const response = await fetch(chainsUrl);

    const resultsJson = await response.json();

    const transactionService = resultsJson.results[0].transactionService;
    rootLogger.info(`Chains: ${JSON.stringify(transactionService)}`);
    rootLogger.info(
      `Add the transaction service url ${transactionService} as gnosisSafeTransactionServiceUrl to the metadata.yml in the registry`,
    );
  } catch (e) {
    rootLogger.error(`Could not fetch safe tx service url: ${e}`);
  }
}

main()
  .then()
  .catch((e) => {
    rootLogger.error(e);
    process.exit(1);
  });
