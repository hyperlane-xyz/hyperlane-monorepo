import { input } from '@inquirer/prompts';
import { ethers } from 'ethers';

import {
  ChainMap,
  ChainMetadata,
  ChainName,
  HyperlaneContractsMap,
  MultiProvider,
  WarpCoreConfig,
  chainMetadata,
  hyperlaneEnvironments,
} from '@hyperlane-xyz/sdk';
import { objFilter, objMap, objMerge } from '@hyperlane-xyz/utils';

import { runDeploymentArtifactStep } from './config/artifacts.js';
import { readChainConfigsIfExists } from './config/chain.js';
import { forkNetworkToMultiProvider } from './deploy/dry-run.js';
import { runSingleChainSelectionStep } from './utils/chains.js';
import { readYamlOrJson } from './utils/files.js';
import { getImpersonatedSigner, getSigner } from './utils/keys.js';

export const sdkContractAddressesMap: HyperlaneContractsMap<any> = {
  ...hyperlaneEnvironments.testnet,
  ...hyperlaneEnvironments.mainnet,
};

export function getMergedContractAddresses(
  artifacts?: HyperlaneContractsMap<any>,
  chains?: ChainName[],
) {
  // if chains include non sdkContractAddressesMap chains, don't recover interchainGasPaymaster
  let sdkContractsAddressesToRecover = sdkContractAddressesMap;
  if (
    chains?.some(
      (chain) => !Object.keys(sdkContractAddressesMap).includes(chain),
    )
  ) {
    sdkContractsAddressesToRecover = objMap(sdkContractAddressesMap, (_, v) =>
      objFilter(
        v as ChainMap<any>,
        (key, v): v is any => key !== 'interchainGasPaymaster',
      ),
    );
  }
  return objMerge(
    sdkContractsAddressesToRecover,
    artifacts || {},
  ) as HyperlaneContractsMap<any>;
}

export type KeyConfig = {
  key?: string;
  promptMessage?: string;
};

export interface ContextSettings {
  chainConfigPath?: string;
  chains?: ChainName[];
  coreConfig?: {
    coreArtifactsPath?: string;
    promptMessage?: string;
  };
  keyConfig?: KeyConfig;
  skipConfirmation?: boolean;
  warpConfig?: {
    warpConfigPath?: string;
    promptMessage?: string;
  };
}

interface CommandContextBase {
  chains: ChainName[];
  customChains: ChainMap<ChainMetadata>;
  multiProvider: MultiProvider;
}

// This makes return type dynamic based on the input settings
type CommandContext<P extends ContextSettings> = CommandContextBase &
  (P extends { keyConfig: object }
    ? { signer: ethers.Signer }
    : { signer: undefined }) &
  (P extends { coreConfig: object }
    ? { coreArtifacts: HyperlaneContractsMap<any> }
    : { coreArtifacts: undefined }) &
  (P extends { warpConfig: object }
    ? { warpCoreConfig: WarpCoreConfig }
    : { warpCoreConfig: undefined });

/**
 * Retrieves context for the user-selected command
 * @returns context for the current command
 */
export async function getContext<P extends ContextSettings>({
  chainConfigPath,
  coreConfig,
  keyConfig,
  skipConfirmation,
  warpConfig,
}: P): Promise<CommandContext<P>> {
  const customChains = readChainConfigsIfExists(chainConfigPath);

  const signer = await getSigner({
    keyConfig,
    skipConfirmation,
  });

  let coreArtifacts = undefined;
  if (coreConfig) {
    coreArtifacts =
      (await runDeploymentArtifactStep({
        artifactsPath: coreConfig.coreArtifactsPath,
        message:
          coreConfig.promptMessage ||
          'Do you want to use some core deployment address artifacts? This is required for PI chains (non-core chains).',
        skipConfirmation,
      })) || {};
  }

  let warpCoreConfig = undefined;
  if (warpConfig) {
    let warpConfigPath = warpConfig.warpConfigPath;
    if (!warpConfigPath) {
      // prompt for path to token config
      warpConfigPath = await input({
        message:
          warpConfig.promptMessage ||
          'Please provide a path to the Warp config',
      });
    }

    warpCoreConfig = readYamlOrJson<WarpCoreConfig>(warpConfigPath);
  }

  const multiProvider = getMultiProvider(customChains, signer);

  return {
    customChains,
    signer,
    multiProvider,
    coreArtifacts,
    warpCoreConfig,
  } as CommandContext<P>;
}

/**
 * Retrieves dry-run context for the user-selected command
 * @returns dry-run context for the current command
 */
export async function getDryRunContext<P extends ContextSettings>({
  chainConfigPath,
  chains,
  coreConfig,
  keyConfig,
  skipConfirmation,
}: P): Promise<CommandContext<P>> {
  const customChains = readChainConfigsIfExists(chainConfigPath);

  let coreArtifacts = undefined;
  if (coreConfig) {
    coreArtifacts =
      (await runDeploymentArtifactStep({
        artifactsPath: coreConfig.coreArtifactsPath,
        message:
          coreConfig.promptMessage ||
          'Do you want to use some core deployment address artifacts? This is required for PI chains (non-core chains).',
        skipConfirmation,
      })) || {};
  }

  const multiProvider = getMultiProvider(customChains);

  if (!chains?.length) {
    if (skipConfirmation) throw new Error('No chains provided');
    chains = [
      await runSingleChainSelectionStep(
        customChains,
        'Select chain to dry-run against:',
      ),
    ];
  }

  await forkNetworkToMultiProvider(multiProvider, chains[0]);

  const impersonatedSigner = await getImpersonatedSigner({
    keyConfig,
    skipConfirmation,
  });

  if (impersonatedSigner) multiProvider.setSharedSigner(impersonatedSigner);

  return {
    chains,
    signer: impersonatedSigner,
    multiProvider,
    coreArtifacts,
  } as CommandContext<P>;
}

/**
 * Retrieves a new MultiProvider based on all known chain metadata & custom user chains
 * @param customChains Custom chains specified by the user
 * @returns a new MultiProvider
 */
export function getMultiProvider(
  customChains: ChainMap<ChainMetadata>,
  signer?: ethers.Signer,
) {
  const chainConfigs = { ...chainMetadata, ...customChains };
  const multiProvider = new MultiProvider(chainConfigs);
  if (signer) multiProvider.setSharedSigner(signer);
  return multiProvider;
}
