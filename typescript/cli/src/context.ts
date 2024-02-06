import { input } from '@inquirer/prompts';
import { ethers } from 'ethers';

import {
  ChainMap,
  ChainMetadata,
  ChainName,
  HyperlaneContractsMap,
  MultiProvider,
  chainMetadata,
  hyperlaneEnvironments,
} from '@hyperlane-xyz/sdk';
import { objFilter, objMerge } from '@hyperlane-xyz/utils';

import { runDeploymentArtifactStep } from './config/artifacts.js';
import { readChainConfigsIfExists } from './config/chain.js';
import { keyToSigner } from './utils/keys.js';

export const sdkContractAddressesMap: HyperlaneContractsMap<any> = {
  ...hyperlaneEnvironments.testnet,
  ...hyperlaneEnvironments.mainnet,
};

// this function filters contracts only for chains that are passed in if provided
export function getMergedContractAddresses(
  artifacts?: HyperlaneContractsMap<any>,
  chains?: ChainName[],
) {
  const completeContractMap = objMerge(
    sdkContractAddressesMap,
    artifacts || {},
  ) as HyperlaneContractsMap<any>;
  if (chains && chains.length !== 0) {
    const filteredContractMap = objFilter(
      completeContractMap,
      (
        chain: ChainName,
        contractsMap,
      ): contractsMap is HyperlaneContractsMap<any> => chains.includes(chain),
    );
    return filteredContractMap;
  } else {
    return completeContractMap;
  }
}

interface ContextSettings {
  chainConfigPath?: string;
  coreConfig?: {
    coreArtifactsPath?: string;
    promptMessage?: string;
  };
  keyConfig?: {
    key?: string;
    promptMessage?: string;
  };
  skipConfirmation?: boolean;
}

interface CommandContextBase {
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
    : { coreArtifacts: undefined });

export async function getContext<P extends ContextSettings>({
  chainConfigPath,
  coreConfig,
  keyConfig,
  skipConfirmation,
}: P): Promise<CommandContext<P>> {
  const customChains = readChainConfigsIfExists(chainConfigPath);

  let signer = undefined;
  if (keyConfig) {
    let key: string;
    if (keyConfig.key) key = keyConfig.key;
    else if (skipConfirmation) throw new Error('No key provided');
    else
      key = await input({
        message:
          keyConfig.promptMessage ||
          'Please enter a private key or use the HYP_KEY environment variable',
      });
    signer = keyToSigner(key);
  }

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

  const multiProvider = getMultiProvider(customChains, signer);

  return {
    customChains,
    signer,
    multiProvider,
    coreArtifacts,
  } as CommandContext<P>;
}

export function getMultiProvider(
  customChains: ChainMap<ChainMetadata>,
  signer?: ethers.Signer,
) {
  const chainConfigs = { ...chainMetadata, ...customChains };
  const mp = new MultiProvider(chainConfigs);
  if (signer) mp.setSharedSigner(signer);
  return mp;
}
