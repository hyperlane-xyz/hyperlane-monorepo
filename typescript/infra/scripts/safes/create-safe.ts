import { SafeFactory } from '@safe-global/protocol-kit';
import { SafeAccountConfig } from '@safe-global/protocol-kit';

import { getChainMetadata } from '../../config/registry.js';
import {
  GCP_PROJECT_ID,
  getSecretManagerServiceClient,
} from '../../src/utils/gcloud.js';
import { readJSONAtPath } from '../../src/utils/utils.js';
import {
  getArgs,
  withChainRequired,
  withSafeTxServiceUrlRequired,
  withThreshold,
} from '../agent-utils.js';

const OWNERS_FILE_PATH = 'config/environments/mainnet3/safe/safeSigners.json';

async function main() {
  const { chain, safeTxServiceUrl, threshold } = await withThreshold(
    withSafeTxServiceUrlRequired(withChainRequired(getArgs())),
  ).argv;

  const chainMetadata = await getChainMetadata();
  const rpcUrls = chainMetadata[chain].rpcUrls;
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
  console.log(
    `Safe url: ${safeTxServiceUrl}/home?safe=${chain}:${safeAddress}`,
  );
  console.log('url may not be correct, please check by following the link');
}

const getDeployerPrivateKey = async () => {
  const client = await getSecretManagerServiceClient();

  const [version] = await client.accessSecretVersion({
    name: `projects/${GCP_PROJECT_ID}/secrets/hyperlane-mainnet3-key-deployer/versions/latest`,
  });

  const payload = version.payload?.data;

  if (!payload) {
    throw new Error('No payload found for deployer key secret');
  }

  const { privateKey } = JSON.parse(payload.toString());

  return privateKey;
};

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
