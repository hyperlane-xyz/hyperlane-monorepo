// This file is JS because of https://github.com/safe-global/safe-core-sdk/issues/805
import SafeApiKit from '@safe-global/api-kit';
import Safe, { EthersAdapter } from '@safe-global/protocol-kit';
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

export function getSafe(chain, multiProvider, safeAddress) {
  const signer = multiProvider.getSigner(chain);
  const ethAdapter = new EthersAdapter({ ethers, signerOrProvider: signer });

  const domainId = multiProvider.getDomainId(chain);
  const contractNetworks = {
    [domainId]: {
      multiSendAddress: safeAddress,
      multiSendCallOnlyAddress: safeAddress,
    },
  };

  return Safe.default.create({
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
