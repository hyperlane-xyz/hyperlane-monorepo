import input from '@inquirer/input';
import { Separator, checkbox, confirm } from '@inquirer/prompts';
import select from '@inquirer/select';
import { ethers } from 'ethers';

import { ChainName } from '@hyperlane-xyz/sdk';
import { ProtocolType, timeout } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { getChain } from '../../config/registry.js';
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
import { WarpRouteMonitorHelmManager } from '../warp-monitor/helm.js';

import { disableGCPSecretVersion } from './gcloud.js';
import { HelmManager } from './helm.js';
import { K8sResourceType, refreshK8sResources } from './k8s.js';

/**
 * Set the RPC URLs for the given chain in the given environment interactively.
 * Includes an interactive experience for selecting new RPC URLs, confirming the change,
 * updating the secret, and refreshing dependent k8s resources.
 * @param environment The environment to set the RPC URLs in
 * @param chain The chain to set the RPC URLs for
 */
export async function setRpcUrlsInteractive(
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
    await confirmSetSecretsInteractive(environment, chain, secretPayload);
    await updateSecretAndDisablePrevious(environment, chain, secretPayload);
    await refreshDependentK8sResourcesInteractive(
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

/**
 * Prompt the user to input RPC URLs for the given chain.
 * The user can choose to input new URLs, use all registry URLs, or use existing URLs
 * from secrets or the registry.
 * @param chain The chain to input RPC URLs for
 * @param existingUrls The existing RPC URLs for the chain
 * @returns The selected RPC URLs
 */
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
  const separator = new Separator('-----');

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
      separator,
      ...existingUrlChoices,
      separator,
      ...registryUrlChoices,
    ];
    if (selectedUrls.length > 0) {
      choices.push(separator);
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
      // If none of the above, a URL was chosen

      let index = existingUrlChoices.findIndex(
        (choice) => choice.value === selection,
      );
      if (index !== -1) {
        existingUrlChoices.splice(index, 1);
      }

      index = registryUrlChoices.findIndex(
        (choice) => choice.value === selection,
      );
      if (index !== -1) {
        registryUrlChoices.splice(index, 1);
      }

      await pushSelectedUrl(selection);
    }
    console.log('========');
  }

  return selectedUrls;
}

/**
 * A prompt to confirm setting the given secret payload for the given chain in the given environment.
 */
async function confirmSetSecretsInteractive(
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

/**
 * Non-interactively updates the secret for the given chain in the given environment with the given payload.
 * Disables the previous version of the secret if it exists.
 * @param environment The environment to update the secret in
 * @param chain The chain to update the secret for
 * @param secretPayload The new secret payload to set
 */
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

/**
 * Interactively refreshes dependent k8s resources for the given chain in the given environment.
 * Prompts for core infrastructure and warp monitors separately, then executes all refreshes together.
 * @param environment The environment to refresh resources in
 * @param chain The chain to refresh resources for
 */
async function refreshDependentK8sResourcesInteractive(
  environment: DeployEnvironment,
  chain: string,
): Promise<void> {
  const cont = await confirm({
    message: `Do you want to refresh dependent k8s resources for ${chain} in ${environment}?`,
  });
  if (!cont) {
    console.log('Skipping refresh of k8s resources');
    return;
  }

  // Collect selections from both prompts
  const coreManagers = await selectCoreInfrastructure(environment, chain);
  const warpManagers = await selectWarpMonitors(environment, chain);

  // Execute all refreshes together
  const allManagers = [...coreManagers, ...warpManagers];
  if (allManagers.length > 0) {
    await refreshK8sResources(allManagers, K8sResourceType.SECRET, environment);
    await refreshK8sResources(allManagers, K8sResourceType.POD, environment);
  }
}

async function selectCoreInfrastructure(
  environment: DeployEnvironment,
  chain: string,
): Promise<HelmManager<any>[]> {
  const envConfig = getEnvironmentConfig(environment);
  const coreHelmManagers: [string, HelmManager<any>][] = [];

  for (const [context, agentConfig] of Object.entries(envConfig.agents)) {
    if (context === Contexts.Neutron) {
      continue;
    }

    if (agentConfig.relayer) {
      coreHelmManagers.push([context, new RelayerHelmManager(agentConfig)]);
    }

    if (
      agentConfig.validators &&
      agentConfig.contextChainNames.validator?.includes(chain)
    ) {
      coreHelmManagers.push([
        context,
        new ValidatorHelmManager(agentConfig, chain),
      ]);
    }

    if (agentConfig.scraper) {
      coreHelmManagers.push([context, new ScraperHelmManager(agentConfig)]);
    }
  }

  if (coreHelmManagers.length === 0) {
    console.log('No core infrastructure to refresh');
    return [];
  }

  const selection = await checkbox({
    message:
      'Select core infrastructure to refresh (update secrets & restart pods)',
    choices: coreHelmManagers.map(([context, helmManager], i) => ({
      name: `${helmManager.helmReleaseName} (context: ${context})`,
      value: i,
      checked: true,
    })),
  });

  return coreHelmManagers
    .map(([_, m]) => m)
    .filter((_, i) => selection.includes(i));
}

enum WarpMonitorRefreshChoice {
  ALL = 'all',
  SELECT = 'select',
  SKIP = 'skip',
}

async function selectWarpMonitors(
  environment: DeployEnvironment,
  chain: string,
): Promise<WarpRouteMonitorHelmManager[]> {
  const warpMonitorManagers =
    await WarpRouteMonitorHelmManager.getManagersForChain(environment, chain);

  if (warpMonitorManagers.length === 0) {
    console.log(`No warp route monitors found for ${chain}`);
    return [];
  }

  console.log(
    `Found ${warpMonitorManagers.length} warp route monitors that include ${chain}:`,
  );
  for (const manager of warpMonitorManagers) {
    console.log(`  - ${manager.helmReleaseName} (${manager.warpRouteId})`);
  }

  const choice = await select({
    message: `Refresh warp route monitors?`,
    choices: [
      {
        name: `Yes, refresh all ${warpMonitorManagers.length} monitors`,
        value: WarpMonitorRefreshChoice.ALL,
      },
      {
        name: 'Yes, let me select which ones',
        value: WarpMonitorRefreshChoice.SELECT,
      },
      {
        name: 'No, skip warp monitors',
        value: WarpMonitorRefreshChoice.SKIP,
      },
    ],
  });

  if (choice === WarpMonitorRefreshChoice.SKIP) {
    console.log('Skipping warp monitor refresh');
    return [];
  }

  if (choice === WarpMonitorRefreshChoice.ALL) {
    return warpMonitorManagers;
  }

  const selection = await checkbox({
    message: 'Select warp monitors to refresh',
    choices: warpMonitorManagers.map((manager, i) => ({
      name: manager.helmReleaseName,
      value: i,
      checked: true,
    })),
  });

  return warpMonitorManagers.filter((_, i) => selection.includes(i));
}

/**
 * Test the provider at the given URL, returning false if the provider is unhealthy
 * or related to a different chain. No-op for non-Ethereum chains.
 * @param chain The chain to test the provider for
 * @param url The URL of the provider
 */
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

function formatRpcUrls(rpcUrls: string[]): string {
  return JSON.stringify(rpcUrls, null, 2);
}
