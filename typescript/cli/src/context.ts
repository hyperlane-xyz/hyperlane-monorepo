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
import { readYamlOrJson } from './utils/files.js';
import { keyToSigner } from './utils/keys.js';

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
  warpConfig?: {
    warpConfigPath?: string;
    promptMessage?: string;
  };
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
    : { coreArtifacts: undefined }) &
  (P extends { warpConfig: object }
    ? { warpCoreConfig: WarpCoreConfig }
    : { warpCoreConfig: undefined });

export async function getContext<P extends ContextSettings>({
  chainConfigPath,
  coreConfig,
  keyConfig,
  skipConfirmation,
  warpConfig,
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
          'Please enter a private key or use the HYP_KEY environment variable.',
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

export function getMultiProvider(
  customChains: ChainMap<ChainMetadata>,
  signer?: ethers.Signer,
) {
  const chainConfigs = { ...chainMetadata, ...customChains };
  const mp = new MultiProvider(chainConfigs);
  if (signer) mp.setSharedSigner(signer);
  return mp;
}
