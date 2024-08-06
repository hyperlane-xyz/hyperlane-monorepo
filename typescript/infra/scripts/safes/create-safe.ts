import { SafeFactory } from '@safe-global/protocol-kit';
import { SafeAccountConfig } from '@safe-global/protocol-kit';

import { Contexts } from '../../config/contexts.js';
import { getChain } from '../../config/registry.js';
import { Role } from '../../src/roles.js';
import { readJSONAtPath } from '../../src/utils/utils.js';
import {
  getArgs,
  getKeyForRole,
  withChainRequired,
  withSafeHomeUrlRequired,
  withThreshold,
} from '../agent-utils.js';

const OWNERS_FILE_PATH = 'config/environments/mainnet3/safe/safeSigners.json';

async function main() {
  const { chain, safeHomeUrl, threshold } = await withThreshold(
    withSafeHomeUrlRequired(withChainRequired(getArgs())),
  ).argv;

  const chainMetadata = await getChain(chain);
  const rpcUrls = chainMetadata.rpcUrls;
  const deployerPrivateKey = await getDeployerPrivateKey();

  let safeFactory;
  try {
    safeFactory = await SafeFactory.init({
      provider: rpcUrls[0].http,
      signer: deployerPrivateKey,
    });
  } catch (e) {
    console.error(`Error initializing SafeFactory: ${e}`);
    process.exit(1);
  }

  const ownersConfig = readJSONAtPath(OWNERS_FILE_PATH);
  const owners = ownersConfig.signers;

  const safeAccountConfig: SafeAccountConfig = {
    owners,
    threshold,
  };

  let safe;
  try {
    safe = await safeFactory.deploySafe({ safeAccountConfig });
  } catch (e) {
    console.error(`Error deploying Safe: ${e}`);
    process.exit(1);
  }

  const safeAddress = await safe.getAddress();

  console.log(`Safe address: ${safeAddress}`);
  console.log(`Safe url: ${safeHomeUrl}/home?safe=${chain}:${safeAddress}`);
  console.log('url may not be correct, please check by following the link');

  try {
    // TODO: check https://app.safe.global for officially supported chains, filter by chain id
    const chainsUrl = `${safeHomeUrl.replace(
      'https://',
      'https://gateway.',
    )}/v1/chains`;
    console.log(`Fetching chain data from ${chainsUrl}`);
    const response = await fetch(chainsUrl);

    const resultsJson = await response.json();

    const transactionService = resultsJson.results[0].transactionService;
    console.log(`Chains: ${JSON.stringify(transactionService)}`);
    console.log(
      `Add the transaction service url ${transactionService} as gnosisSafeTransactionServiceUrl to the metadata.yml in the registry`,
    );
  } catch (e) {
    console.error(`Could not fetch safe tx service url: ${e}`);
  }
}

const getDeployerPrivateKey = async () => {
  const key = await getKeyForRole(
    'mainnet3',
    Contexts.Hyperlane,
    Role.Deployer,
  );
  await key.fetch();

  return key.privateKey;
};

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
