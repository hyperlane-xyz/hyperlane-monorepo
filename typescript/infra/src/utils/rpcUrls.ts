import input from '@inquirer/input';
import { Separator, checkbox, confirm } from '@inquirer/prompts';
import select from '@inquirer/select';
import { ethers } from 'ethers';

import { ChainName } from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  pollAsync,
  runWithTimeout,
  sleep,
  timeout,
} from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { getChain } from '../../config/registry.js';
import { getAgentConfig } from '../../scripts/agent-utils.js';
import { getEnvironmentConfig } from '../../scripts/core-utils.js';
import {
  RelayerHelmManager,
  ScraperHelmManager,
  ValidatorHelmManager,
  getSecretRpcEndpoints,
  getSecretRpcEndpointsLatestVersionName,
  secretRpcEndpointsExist,
  setSecretRpcEndpoints,
} from '../agents/index.js';
import { DeployEnvironment } from '../config/environment.js';
import { KeyFunderHelmManager } from '../funding/key-funder.js';
import { KathyHelmManager } from '../helloworld/kathy.js';

import { disableGCPSecretVersion } from './gcloud.js';
import { HelmManager } from './helm.js';
import { execCmd } from './utils.js';

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
      `✅  Valid provider for ${url} with block number ${blockNumber}`,
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
    // await updateSecretAndDisablePrevious(environment, chain, secretPayload);
    await refreshAllDependentK8sResources(
      environment as DeployEnvironment,
      chain,
    );
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

// Copied from @inquirer/prompts as it's not exported :(
type Choice<Value> = {
  value: Value;
  name?: string;
  description?: string;
  short?: string;
  disabled?: boolean | string;
  type?: never;
};

async function inputRpcUrls(
  chain: string,
  existingUrls: string[],
): Promise<string[]> {
  const selectedUrls: string[] = [];

  const registryUrls = getChain(chain).rpcUrls.map((rpc) => rpc.http);

  const existingUrlChoices: Array<Choice<string>> = existingUrls.map(
    (url, i) => {
      return {
        value: url,
        name: `${url} (existing index ${i})`,
      };
    },
  );
  const registryUrlChoices: Array<Choice<string>> = registryUrls.map(
    (url, i) => {
      return {
        value: url,
        name: `[PUBLIC] ${url} (registry index ${i})`,
      };
    },
  );

  enum SystemChoice {
    ADD_NEW = 'Add new RPC URL',
    DONE = 'Done',
    USE_REGISTRY_URLS = 'Use all registry URLs',
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
    const choices: (Separator | Choice<any>)[] = [
      ...[SystemChoice.DONE, SystemChoice.ADD_NEW].map((choice) => ({
        value: choice,
      })),
      {
        value: SystemChoice.USE_REGISTRY_URLS,
        name: `Use registry URLs (${JSON.stringify(registryUrls)})`,
      },
      new Separator('-----'),
      ...existingUrlChoices,
      new Separator('-----'),
      ...registryUrlChoices,
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
      pageSize: 30,
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
    } else if (selection === SystemChoice.USE_REGISTRY_URLS) {
      for (const url of registryUrls) {
        await pushSelectedUrl(url);
      }
      console.log('Added all registry URLs');
      break;
    } else {
      let index = existingUrls.indexOf(selection);
      if (index !== -1) {
        existingUrlChoices.splice(index, 1);
      }

      index = registryUrls.indexOf(selection);
      if (index !== -1) {
        registryUrls.splice(index, 1);
      }

      await pushSelectedUrl(selection);
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

async function refreshAllDependentK8sResources(
  environment: DeployEnvironment,
  chain: string,
): Promise<void> {
  const cont = await confirm({
    message: `Do you want to refresh all dependent k8s resources for ${chain} in ${environment}?`,
  });
  if (!cont) {
    console.log('Skipping refresh of k8s resources');
    return;
  }

  const envConfig = getEnvironmentConfig(environment);
  const contextHelmManagers: [string, HelmManager<any>][] = [];
  const pushContextHelmManager = (
    context: string,
    manager: HelmManager<any>,
  ) => {
    contextHelmManagers.push([context, manager]);
  };
  for (const [context, agentConfig] of Object.entries(envConfig.agents)) {
    if (agentConfig.relayer) {
      pushContextHelmManager(context, new RelayerHelmManager(agentConfig));
    }
    if (agentConfig.validators) {
      pushContextHelmManager(
        context,
        new ValidatorHelmManager(agentConfig, chain),
      );
    }
    if (agentConfig.scraper) {
      pushContextHelmManager(context, new ScraperHelmManager(agentConfig));
    }

    if (context == Contexts.Hyperlane) {
      // Key funder
      pushContextHelmManager(
        context,
        KeyFunderHelmManager.forEnvironment(environment),
      );

      // Kathy - only expected to be running as a long-running service in the
      // Hyperlane context
      if (envConfig.helloWorld?.hyperlane?.addresses[chain]) {
        pushContextHelmManager(
          context,
          KathyHelmManager.forEnvironment(environment, context),
        );
      }
    }
  }

  const selection = await checkbox({
    message:
      'Select deployments to refresh (update secrets & restart any pods)',
    choices: contextHelmManagers.map(([context, helmManager], i) => ({
      name: `${helmManager.helmReleaseName} (context: ${context})`,
      value: i,
      // By default, all deployments are selected
      checked: true,
    })),
  });
  const selectedHelmManagers = contextHelmManagers
    .map(([_, m]) => m)
    .filter((_, m) => selection.includes(m));

  await refreshK8sResources(
    selectedHelmManagers,
    K8sResourceType.SECRET,
    environment,
  );
  await refreshK8sResources(
    selectedHelmManagers,
    K8sResourceType.POD,
    environment,
  );
}

enum K8sResourceType {
  SECRET = 'secret',
  POD = 'pod',
}

async function refreshK8sResources(
  helmManagers: HelmManager<any>[],
  resourceType: K8sResourceType,
  namespace: string,
) {
  const resourceNames = (
    await Promise.all(
      helmManagers.map(async (helmManager) => {
        if (resourceType === K8sResourceType.SECRET) {
          return helmManager.getExistingK8sSecrets();
        } else if (resourceType === K8sResourceType.POD) {
          return helmManager.getManagedK8sPods();
        } else {
          throw new Error(`Unknown resource type: ${resourceType}`);
        }
      }),
    )
  ).flat();

  console.log(`Ready to delete ${resourceType}s: ${resourceNames.join(', ')}`);

  const cont = await confirm({
    message: `Proceed and delete ${resourceNames.length} ${resourceType}s?`,
  });
  if (!cont) {
    throw new Error('Aborting');
  }

  await execCmd(
    `kubectl delete ${resourceType} ${resourceNames.join(' ')} -n ${namespace}`,
  );
  console.log(
    `🏗  Deleted ${resourceNames.length} ${resourceType}s, waiting for them to be recreated...`,
  );

  await waitForK8sResources(resourceType, resourceNames, namespace);
}

// Polls until all resources are ready.
// For secrets, this means they exist.
// For pods, this means they exist and are running.
async function waitForK8sResources(
  resourceType: K8sResourceType,
  resourceNames: string[],
  namespace: string,
) {
  const resourceGetter =
    resourceType === K8sResourceType.SECRET
      ? getExistingK8sSecrets
      : getRunningK8sPods;

  try {
    await pollAsync(
      async () => {
        const { missing } = await resourceGetter(resourceNames, namespace);
        if (missing.length > 0) {
          console.log(
            `⏳ ${resourceNames.length - missing.length} of ${
              resourceNames.length
            } ${resourceType}s up, waiting for ${missing.length} more`,
          );
          throw new Error(
            `${resourceType}s not ready, ${missing.length} missing`,
          );
        }
      },
      2000,
      30,
    );
    console.log(`✅  All ${resourceNames.length} ${resourceType}s exist`);
  } catch (e) {
    console.error(`Error waiting for ${resourceType}s to exist: ${e}`);
  }
}

async function getExistingK8sSecrets(
  resourceNames: string[],
  namespace: string,
): Promise<{
  existing: string[];
  missing: string[];
}> {
  const [output] = await execCmd(
    `kubectl get secret ${resourceNames.join(
      ' ',
    )} -n ${namespace} --ignore-not-found -o jsonpath='{.items[*].metadata.name}'`,
  );
  const existing = output.split(' ').filter(Boolean);
  const missing = resourceNames.filter(
    (resource) => !existing.includes(resource),
  );
  return { existing, missing };
}

async function getRunningK8sPods(
  resourceNames: string[],
  namespace: string,
): Promise<{
  existing: string[];
  missing: string[];
}> {
  // Returns a newline separated list of pod names and their statuses, e.g.:
  //   pod1:Running
  //   pod2:Pending
  //   pod3:Running
  // Interestingly, providing names here is incompatible with the jsonpath range syntax. So we get all pods
  // and filter.
  const [output] = await execCmd(
    `kubectl get pods -n ${namespace} --ignore-not-found -o jsonpath='{range .items[*]}{.metadata.name}:{.status.phase}{"\\n"}{end}'`,
  );
  // Filter out pods that are not in the list of resource names or are not running
  const running = output
    .split('\n')
    .map((line) => {
      const [pod, status] = line.split(':');
      return resourceNames.includes(pod) && status === 'Running'
        ? pod
        : undefined;
    })
    .filter((pod) => pod !== undefined);
  const missing = resourceNames.filter(
    (resource) => !running.includes(resource),
  );
  return { existing: running, missing };
}
