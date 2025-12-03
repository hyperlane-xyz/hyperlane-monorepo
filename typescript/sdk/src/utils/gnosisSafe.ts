import SafeApiKit from '@safe-global/api-kit';
import Safe, { SafeProviderConfig } from '@safe-global/protocol-kit';
import {
  getMultiSendCallOnlyDeployment,
  getMultiSendDeployment,
} from '@safe-global/safe-deployments';

import { Address } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainName } from '../types.js';

export function safeApiKeyRequired(txServiceUrl: string): boolean {
  return /safe\.global|5afe\.dev/.test(txServiceUrl);
}

export function getSafeService(
  chain: ChainName,
  multiProvider: MultiProvider,
): SafeApiKit.default {
  const { gnosisSafeTransactionServiceUrl, gnosisSafeApiKey } =
    multiProvider.getChainMetadata(chain);
  let txServiceUrl = gnosisSafeTransactionServiceUrl;
  if (!txServiceUrl) {
    throw new Error(`must provide tx service url for ${chain}`);
  }

  // Ensure txServiceUrl ends with /api
  if (
    !txServiceUrl.endsWith('/api') &&
    !txServiceUrl.endsWith('/api/') &&
    !txServiceUrl.endsWith('api')
  ) {
    // Remove trailing slash if present to avoid double slashes
    txServiceUrl = txServiceUrl.replace(/\/+$/, '');
    txServiceUrl = `${txServiceUrl}/api`;
  }

  const chainId = multiProvider.getEvmChainId(chain);
  if (!chainId) {
    throw new Error(`Chain is not an EVM chain: ${chain}`);
  }

  // @ts-ignore
  return new SafeApiKit({
    chainId: BigInt(chainId),
    txServiceUrl,
    // Only provide apiKey if the url contains safe.global or 5afe.dev
    apiKey: safeApiKeyRequired(txServiceUrl) ? gnosisSafeApiKey : undefined,
  });
}

// This is the version of the Safe contracts that the SDK is compatible with.
// Copied the MVP fields from https://github.com/safe-global/safe-core-sdk/blob/4d1c0e14630f951c2498e1d4dd521403af91d6e1/packages/protocol-kit/src/contracts/config.ts#L19
// because the SDK doesn't expose this value.
const safeDeploymentsVersions: Record<
  string,
  { multiSendVersion: string; multiSendCallOnlyVersion: string }
> = {
  '1.4.1': {
    multiSendVersion: '1.4.1',
    multiSendCallOnlyVersion: '1.4.1',
  },
  '1.3.0': {
    multiSendVersion: '1.3.0',
    multiSendCallOnlyVersion: '1.3.0',
  },
  '1.2.0': {
    multiSendVersion: '1.1.1',
    multiSendCallOnlyVersion: '1.3.0',
  },
  '1.1.1': {
    multiSendVersion: '1.1.1',
    multiSendCallOnlyVersion: '1.3.0',
  },
  '1.0.0': {
    multiSendVersion: '1.1.1',
    multiSendCallOnlyVersion: '1.3.0',
  },
};

// Override for chains that haven't yet been published in the safe-deployments package.
// Temporary until PR to safe-deployments package is merged and SDK dependency is updated.
const chainOverrides: Record<
  string,
  { multiSend: string; multiSendCallOnly: string }
> = {
  // zeronetwork
  543210: {
    multiSend: '0x0dFcccB95225ffB03c6FBB2559B530C2B7C8A912',
    multiSendCallOnly: '0xf220D3b4DFb23C4ade8C88E526C1353AbAcbC38F',
  },
  // berachain
  80094: {
    multiSend: '0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761',
    multiSendCallOnly: '0x40A2aCCbd92BCA938b02010E17A5b8929b49130D',
  },
};

export async function getSafe(
  chain: ChainName,
  multiProvider: MultiProvider,
  safeAddress: Address,
  signer?: SafeProviderConfig['signer'],
): Promise<Safe.default> {
  // Get the chain id for the given chain
  const chainId = `${multiProvider.getEvmChainId(chain)}`;

  // Get the safe version
  const safeService = getSafeService(chain, multiProvider);

  const { version: rawSafeVersion } =
    await safeService.getSafeInfo(safeAddress);
  // Remove any build metadata from the version e.g. 1.3.0+L2 --> 1.3.0
  const safeVersion = rawSafeVersion.split(' ')[0].split('+')[0].split('-')[0];

  // Get the multiSend and multiSendCallOnly deployments for the given chain
  let multiSend, multiSendCallOnly;
  if (chainOverrides[chainId]) {
    multiSend = {
      networkAddresses: { [chainId]: chainOverrides[chainId].multiSend },
    };
    multiSendCallOnly = {
      networkAddresses: {
        [chainId]: chainOverrides[chainId].multiSendCallOnly,
      },
    };
  } else if (safeDeploymentsVersions[safeVersion]) {
    const { multiSendVersion, multiSendCallOnlyVersion } =
      safeDeploymentsVersions[safeVersion];
    multiSend = getMultiSendDeployment({
      version: multiSendVersion,
      network: chainId,
    });
    multiSendCallOnly = getMultiSendCallOnlyDeployment({
      version: multiSendCallOnlyVersion,
      network: chainId,
    });
  }

  // @ts-ignore
  return Safe.init({
    provider: multiProvider.getChainMetadata(chain).rpcUrls[0].http,
    signer,
    safeAddress,
    contractNetworks: {
      [chainId]: {
        // Use the safe address for multiSendAddress and multiSendCallOnlyAddress
        // if the contract is not deployed or if the version is not found.
        multiSendAddress: multiSend?.networkAddresses[chainId] || safeAddress,
        multiSendCallOnlyAddress:
          multiSendCallOnly?.networkAddresses[chainId] || safeAddress,
      },
    },
  });
}

export async function getSafeDelegates(
  service: SafeApiKit.default,
  safeAddress: Address,
): Promise<string[]> {
  const delegateResponse = await service.getSafeDelegates({ safeAddress });
  return delegateResponse.results.map((r) => r.delegate);
}

export async function canProposeSafeTransactions(
  proposer: Address,
  chain: ChainName,
  multiProvider: MultiProvider,
  safeAddress: Address,
): Promise<boolean> {
  let safeService: SafeApiKit.default;
  try {
    safeService = getSafeService(chain, multiProvider);
  } catch {
    return false;
  }
  const safe = await getSafe(chain, multiProvider, safeAddress);
  const delegates = await getSafeDelegates(safeService, safeAddress);
  const owners = await safe.getOwners();
  return delegates.includes(proposer) || owners.includes(proposer);
}
