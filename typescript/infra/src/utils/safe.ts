import SafeApiKit from '@safe-global/api-kit';
import Safe, { EthersAdapter } from '@safe-global/protocol-kit';
import { ethers } from 'ethers';

import { ChainName, MultiProvider, chainMetadata } from '@hyperlane-xyz/sdk';

export function getSafeService(
  chain: ChainName,
  multiProvider: MultiProvider,
): SafeApiKit {
  const signer = multiProvider.getSigner(chain);
  const ethAdapter = new EthersAdapter({ ethers, signerOrProvider: signer });
  const txServiceUrl = chainMetadata[chain].gnosisSafeTransactionServiceUrl;
  if (!txServiceUrl)
    throw new Error(`must provide tx service url for ${chain}`);
  return new SafeApiKit({ txServiceUrl, ethAdapter });
}

export function getSafe(
  chain: ChainName,
  multiProvider: MultiProvider,
  safeAddress: string,
): Promise<Safe> {
  const signer = multiProvider.getSigner(chain);
  const ethAdapter = new EthersAdapter({ ethers, signerOrProvider: signer });
  return Safe.create({
    ethAdapter,
    safeAddress: safeAddress,
  });
}

export async function getSafeDelegates(
  service: SafeApiKit,
  safeAddress: string,
) {
  const delegateResponse = await service.getSafeDelegates({ safeAddress });
  return delegateResponse.results.map((r) => r.delegate);
}

export async function canProposeSafeTransactions(
  proposer: string,
  chain: ChainName,
  multiProvider: MultiProvider,
  safeAddress: string,
): Promise<boolean> {
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
