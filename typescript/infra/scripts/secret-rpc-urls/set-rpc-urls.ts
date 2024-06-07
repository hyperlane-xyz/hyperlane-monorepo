import { confirm } from '@inquirer/prompts';
import { ethers } from 'ethers';

import {
  getSecretRpcEndpoints,
  getSecretRpcEndpointsLatestVersionName,
  secretRpcEndpointsExist,
  setSecretRpcEndpoints,
} from '../../src/agents/index.js';
import { disableGCPSecretVersion } from '../../src/utils/gcloud.js';
import { isEthereumProtocolChain } from '../../src/utils/utils.js';
import { getArgs, withChain, withRpcUrls } from '../agent-utils.js';

async function testProviders(rpcUrlsArray: string[]): Promise<boolean> {
  let providersSucceeded = true;
  for (const url of rpcUrlsArray) {
    const provider = new ethers.providers.StaticJsonRpcProvider(url);
    try {
      const blockNumber = await provider.getBlockNumber();
      console.log(`Valid provider for ${url} with block number ${blockNumber}`);
    } catch (e) {
      console.error(`Provider failed: ${url}`);
      providersSucceeded = false;
    }
  }

  return providersSucceeded;
}

async function main() {
  const { environment, chain, rpcUrls } = await withRpcUrls(
    withChain(getArgs()),
  ).argv;

  const rpcUrlsArray = rpcUrls
    .split(/,\s*/)
    .filter(Boolean) // filter out empty strings
    .map((url) => url.trim());

  if (!rpcUrlsArray.length) {
    console.error('No rpc urls provided, Exiting.');
    process.exit(1);
  }

  const secretPayload = JSON.stringify(rpcUrlsArray);

  const secretExists = await secretRpcEndpointsExist(environment, chain);
  if (!secretExists) {
    console.log(
      `No secret rpc urls found for ${chain} in ${environment} environment\n`,
    );
  } else {
    const currentSecrets = await getSecretRpcEndpoints(environment, chain);
    console.log(
      `Current secrets found for ${chain} in ${environment} environment:\n${JSON.stringify(
        currentSecrets,
        null,
        2,
      )}\n`,
    );
  }

  const confirmedSet = await confirm({
    message: `Are you sure you want to set the following RPC URLs for ${chain} in ${environment}?\n${secretPayload}\n`,
  });

  if (!confirmedSet) {
    console.log('Exiting without setting secret.');
    process.exit(0);
  }

  if (isEthereumProtocolChain(chain)) {
    console.log('\nTesting providers...');
    const testPassed = await testProviders(rpcUrlsArray);
    if (!testPassed) {
      console.error('At least one provider failed. Exiting.');
      process.exit(1);
    }

    const confirmedProviders = await confirm({
      message: `All providers passed. Do you want to continue setting the secret?\n`,
    });

    if (!confirmedProviders) {
      console.log('Exiting without setting secret.');
      process.exit(0);
    }
  } else {
    console.log(
      'Skipping provider testing as chain is not an Ethereum protocol chain.',
    );
  }

  let latestVersionName;
  if (secretExists) {
    latestVersionName = await getSecretRpcEndpointsLatestVersionName(
      environment,
      chain,
    );
  }
  console.log(`Setting secret...`);
  await setSecretRpcEndpoints(environment, chain, secretPayload);
  console.log(`Added secret version!`);

  if (latestVersionName) {
    try {
      await disableGCPSecretVersion(latestVersionName);
      console.log(`Disabled previous version of the secret!`);
    } catch (e) {
      console.log(`Could not disable previous version of the secret`);
    }
  }
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
