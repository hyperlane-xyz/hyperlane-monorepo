import input from '@inquirer/input';
import { Separator, confirm } from '@inquirer/prompts';
import select from '@inquirer/select';
import { ethers } from 'ethers';

import { ChainName } from '@hyperlane-xyz/sdk';
import { ProtocolType, timeout } from '@hyperlane-xyz/utils';

import { getChain } from '../../config/registry.js';
import {
  getSecretRpcEndpoints,
  getSecretRpcEndpointsLatestVersionName,
  secretRpcEndpointsExist,
  setSecretRpcEndpoints,
} from '../agents/index.js';

import { disableGCPSecretVersion } from './gcloud.js';
import { isEthereumProtocolChain } from './utils.js';

// export async function testProviders(rpcUrlsArray: string[]): Promise<boolean> {
//   let providersSucceeded = true;
//   for (const url of rpcUrlsArray) {
//     const provider = new ethers.providers.StaticJsonRpcProvider(url);
//     try {
//       const blockNumber = await timeout(provider.getBlockNumber(), 5000);
//       console.log(`Valid provider for ${url} with block number ${blockNumber}`);
//     } catch (e) {
//       console.error(`Provider failed: ${url}`);
//       providersSucceeded = false;
//     }
//   }

//   return providersSucceeded;
// }

async function testProvider(chain: ChainName, url: string): Promise<boolean> {
  const chainMetadata = getChain(chain);
  if (chainMetadata.protocol !== ProtocolType.Ethereum) {
    console.log(`Skipping provider test for non-Ethereum chain ${chain}`);
    return true;
  }

  const provider = new ethers.providers.StaticJsonRpcProvider(url);
  const expectedChainId = chainMetadata.chainId;

  try {
    const [blockNumber, providerNetwork] = await timeout(
      Promise.all([provider.getBlockNumber(), provider.getNetwork()]),
      5000,
    );
    if (providerNetwork.chainId !== expectedChainId) {
      throw new Error(
        `Expected chainId ${expectedChainId}, got ${providerNetwork.chainId}`,
      );
    }
    console.log(
      `✅ Valid provider for ${url} with block number ${blockNumber}`,
    );
    return true;
  } catch (e) {
    console.error(`Provider failed: ${url}\nError: ${e}`);
    return false;
  }
}

export async function setAndVerifyRpcUrls(
  environment: string,
  chain: string,
): Promise<void> {
  try {
    const currentSecrets = await getAndDisplayCurrentSecrets(
      environment,
      chain,
    );
    const newRpcUrls = await inputRpcUrls(chain, currentSecrets);
    console.log(`Selected RPC URLs: ${formatRpcUrls(newRpcUrls)}\n`);

    const secretPayload = JSON.stringify(newRpcUrls);
    await confirmSetSecrets(environment, chain, secretPayload);
    // await testProvidersIfNeeded(chain, rpcUrlsArray);
    await updateSecretAndDisablePrevious(environment, chain, secretPayload);
  } catch (error: any) {
    console.error(
      `Error occurred while setting RPC URLs for ${chain}:`,
      error.message,
    );
    return;
  }
}

function formatRpcUrls(rpcUrls: string[]): string {
  return JSON.stringify(rpcUrls, null, 2);
}

async function getAndDisplayCurrentSecrets(
  environment: string,
  chain: string,
): Promise<string[]> {
  const secretExists = await secretRpcEndpointsExist(environment, chain);
  if (!secretExists) {
    console.log(
      `No secret rpc urls found for ${chain} in ${environment} environment\n`,
    );
    return [];
  }

  const currentSecrets = await getSecretRpcEndpoints(environment, chain);
  console.log(
    `Current secrets found for ${chain} in ${environment} environment:\n${formatRpcUrls(
      currentSecrets,
    )}\n`,
  );
  return currentSecrets;
}

async function inputRpcUrls(
  chain: string,
  existingUrls: string[],
): Promise<string[]> {
  const selectedUrls: string[] = [];

  const remainingExistingChoices = Object.fromEntries(
    existingUrls.map((url, i) => {
      return [
        url,
        {
          value: url,
          name: `${url} (existing index ${i})`,
        },
      ];
    }),
  );

  enum SystemChoice {
    ADD_NEW = 'Add new RPC URL',
    DONE = 'Done',
    REMOVE_LAST = 'Remove last RPC URL',
  }

  const pushSelectedUrl = async (newUrl: string) => {
    const providerHealthy = await testProvider(chain, newUrl);
    if (!providerHealthy) {
      const yes = await confirm({
        message: `Provider at ${newUrl} is not healthy. Do you want to continue adding it?\n`,
      });
      if (!yes) {
        console.log('Skipping provider');
        return;
      }
    }
    selectedUrls.push(newUrl);
  };

  while (true) {
    console.log(`Selected RPC URLs: ${formatRpcUrls(selectedUrls)}\n`);

    // Sadly @inquirer/prompts doesn't expose the types needed here
    const choices: (Separator | { value: string })[] = [
      ...[SystemChoice.DONE, SystemChoice.ADD_NEW].map((choice) => ({
        value: choice,
      })),
      ...Object.values(remainingExistingChoices),
    ];
    if (selectedUrls.length > 0) {
      choices.push(new Separator('-----'));
      choices.push({
        value: SystemChoice.REMOVE_LAST,
      });
    }

    const selection = await select({
      message: 'Select RPC URL',
      choices,
    });

    if (selection === SystemChoice.DONE) {
      console.log('Done selecting RPC URLs');
      break;
    } else if (selection === SystemChoice.ADD_NEW) {
      const newUrl = await input({
        message: 'Enter new RPC URL',
      });
      await pushSelectedUrl(newUrl);
    } else if (selection === SystemChoice.REMOVE_LAST) {
      selectedUrls.pop();
    } else if (remainingExistingChoices[selection]) {
      await pushSelectedUrl(selection);
      delete remainingExistingChoices[selection];
    }
    console.log('========');
  }

  return selectedUrls;
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

// async function testProvidersIfNeeded(
//   chain: string,
//   rpcUrlsArray: string[],
// ): Promise<void> {
//   if (isEthereumProtocolChain(chain)) {
//     console.log('\nTesting providers...');
//     const testPassed = await testProviders(rpcUrlsArray);
//     if (!testPassed) {
//       console.error('At least one provider failed.');
//       throw new Error('Provider test failed');
//     }

//     const confirmedProviders = await confirm({
//       message: `All providers passed. Do you want to continue setting the secret?\n`,
//     });

//     if (!confirmedProviders) {
//       console.log('Continuing without setting secret.');
//       throw new Error('User cancelled operation after provider test');
//     }
//   } else {
//     console.log(
//       'Skipping provider testing as chain is not an Ethereum protocol chain.',
//     );
//   }
// }

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
