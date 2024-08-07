import { confirm } from '@inquirer/prompts';
import { ethers } from 'ethers';

import { timeout } from '@hyperlane-xyz/utils';

import {
  getSecretRpcEndpoints,
  getSecretRpcEndpointsLatestVersionName,
  secretRpcEndpointsExist,
  setSecretRpcEndpoints,
} from '../agents/index.js';

import { disableGCPSecretVersion } from './gcloud.js';
import { isEthereumProtocolChain } from './utils.js';

export async function testProviders(rpcUrlsArray: string[]): Promise<boolean> {
  let providersSucceeded = true;
  for (const url of rpcUrlsArray) {
    const provider = new ethers.providers.StaticJsonRpcProvider(url);
    try {
      const blockNumber = await timeout(provider.getBlockNumber(), 5000);
      console.log(`Valid provider for ${url} with block number ${blockNumber}`);
    } catch (e) {
      console.error(`Provider failed: ${url}`);
      providersSucceeded = false;
    }
  }

  return providersSucceeded;
}

export async function setAndVerifyRpcUrls(
  environment: string,
  chain: string,
  rpcUrlsArray: string[],
): Promise<void> {
  const secretPayload = JSON.stringify(rpcUrlsArray);

  try {
    await displayCurrentSecrets(environment, chain);
    await confirmSetSecrets(environment, chain, secretPayload);
    await testProvidersIfNeeded(chain, rpcUrlsArray);
    await updateSecretAndDisablePrevious(environment, chain, secretPayload);
  } catch (error: any) {
    console.error(
      `Error occurred while setting RPC URLs for ${chain}:`,
      error.message,
    );
    return;
  }
}

async function displayCurrentSecrets(
  environment: string,
  chain: string,
): Promise<void> {
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
}

async function confirmSetSecrets(
  environment: string,
  chain: string,
  secretPayload: string,
): Promise<void> {
  const confirmedSet = await confirm({
    message: `Are you sure you want to set the following RPC URLs for ${chain} in ${environment}?\n${secretPayload}\n`,
  });

  if (!confirmedSet) {
    console.log('Continuing without setting secret.');
    throw new Error('User cancelled operation');
  }
}

async function testProvidersIfNeeded(
  chain: string,
  rpcUrlsArray: string[],
): Promise<void> {
  if (isEthereumProtocolChain(chain)) {
    console.log('\nTesting providers...');
    const testPassed = await testProviders(rpcUrlsArray);
    if (!testPassed) {
      console.error('At least one provider failed.');
      throw new Error('Provider test failed');
    }

    const confirmedProviders = await confirm({
      message: `All providers passed. Do you want to continue setting the secret?\n`,
    });

    if (!confirmedProviders) {
      console.log('Continuing without setting secret.');
      throw new Error('User cancelled operation after provider test');
    }
  } else {
    console.log(
      'Skipping provider testing as chain is not an Ethereum protocol chain.',
    );
  }
}

async function updateSecretAndDisablePrevious(
  environment: string,
  chain: string,
  secretPayload: string,
): Promise<void> {
  const secretExists = await secretRpcEndpointsExist(environment, chain);
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
