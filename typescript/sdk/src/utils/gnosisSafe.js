// This file is JS because of https://github.com/safe-global/safe-core-sdk/issues/805
import SafeApiKit from '@safe-global/api-kit';
import Safe, {
  EthersAdapter,
  safeDeploymentsVersions,
} from '@safe-global/protocol-kit';
import {
  getMultiSendCallOnlyDeployment,
  getMultiSendDeployment,
} from '@safe-global/safe-deployments';
import { ethers } from 'ethers';

export function getSafeService(chain, multiProvider) {
  const signer = multiProvider.getSigner(chain);
  const ethAdapter = new EthersAdapter({ ethers, signerOrProvider: signer });
  const txServiceUrl =
    multiProvider.getChainMetadata(chain).gnosisSafeTransactionServiceUrl;
  if (!txServiceUrl)
    throw new Error(`must provide tx service url for ${chain}`);
  return new SafeApiKit.default({ txServiceUrl, ethAdapter });
}

// Default safe version to use if not specified
const DEFAULT_SAFE_VERSION = '1.3.0';
const safeVersionOverrides = {
  ancient8: '1.1.1',
};

export function getSafe(chain, multiProvider, safeAddress) {
  // Create Ethers Adapter
  const signer = multiProvider.getSigner(chain);
  const ethAdapter = new EthersAdapter({ ethers, signerOrProvider: signer });

  // Get the domain id for the given chain
  const domainId = multiProvider.getDomainId(chain);

  // Get the default contract addresses for the given chain
  const safeVersion = safeVersionOverrides[chain] || DEFAULT_SAFE_VERSION;
  const { multiSendVersion, multiSendCallOnlyVersion } =
    safeDeploymentsVersions[safeVersion];
  const multiSendAddress = getMultiSendDeployment({
    version: multiSendVersion,
    network: domainId,
    released: true,
  }).defaultAddress;
  const multiSendCallOnlyAddress = getMultiSendCallOnlyDeployment({
    version: multiSendCallOnlyVersion,
    network: domainId,
    released: true,
  }).defaultAddress;

  // Only update contractNetworks if default multiSend addresses are missing
  const contractNetworks = {
    [domainId]: {
      multiSendAddress,
      multiSendCallOnlyAddress,
    },
  };

  // If the default addresses are missing, set them to the zero address
  if (!multiSendAddress || !multiSendCallOnlyAddress) {
    contractNetworks[domainId] = {
      multiSendAddress: ethers.constants.AddressZero,
      multiSendCallOnlyAddress: ethers.constants.AddressZero,
    };
  }

  return Safe.create({
    ethAdapter,
    safeAddress,
    contractNetworks,
  });
}

export async function getSafeDelegates(service, safeAddress) {
  const delegateResponse = await service.getSafeDelegates({ safeAddress });
  return delegateResponse.results.map((r) => r.delegate);
}

export async function canProposeSafeTransactions(
  proposer,
  chain,
  multiProvider,
  safeAddress,
) {
  let safeService;
  try {
    safeService = getSafeService(chain, multiProvider);
  } catch (e) {
    return false;
  }
  const safe = await getSafe(chain, multiProvider, safeAddress);
  const delegates = await getSafeDelegates(safeService, safeAddress);
  const owners = await safe.getOwners();
  return delegates.includes(proposer) || owners.includes(proposer);
}
