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
import { objFilter, objMap, objMerge } from '@hyperlane-xyz/utils';

import { runDeploymentArtifactStep } from './config/artifacts.js';
import { readChainConfigsIfExists } from './config/chain.js';
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
  key?: string;
}

interface CommandContextBase {
  customChains: ChainMap<ChainMetadata>;
  multiProvider: MultiProvider;
}

type CommandContext<P extends ContextSettings> = CommandContextBase &
  (P extends { key: string }
    ? { signer: ethers.Signer }
    : { signer: undefined }) &
  (P extends { coreConfig: object }
    ? { coreArtifacts: HyperlaneContractsMap<any> }
    : { coreArtifacts: undefined });

export async function getContext<P extends ContextSettings>(
  settings: P,
): Promise<CommandContext<P>> {
  const customChains = readChainConfigsIfExists(settings.chainConfigPath);
  const signer = settings.key ? keyToSigner(settings.key) : undefined;
  const multiProvider = getMultiProvider(customChains, signer);

  let coreArtifacts = undefined;
  if (settings.coreConfig) {
    coreArtifacts =
      (await runDeploymentArtifactStep(
        settings.coreConfig.coreArtifactsPath,
        settings.coreConfig.promptMessage ||
          'Do you want to use some core deployment address artifacts? This is required for warp deployments to PI chains (non-core chains).',
      )) || {};
  }

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
