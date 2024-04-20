import _SafeApiKit from '@safe-global/api-kit';
import _Safe, { EthersAdapter } from '@safe-global/protocol-kit';
import { ethers } from 'ethers';

import { ChainName, MultiProvider } from '@hyperlane-xyz/sdk';

import { getChain } from '../../config/registry.js';

// Due to https://github.com/safe-global/safe-core-sdk/issues/419
// See also https://github.com/safe-global/safe-core-sdk/issues/514
const SafeApiKit = _SafeApiKit.default;
const Safe = _Safe.default;

export function getSafeService(
  chain: ChainName,
  multiProvider: MultiProvider,
): _SafeApiKit.default {
  const signer = multiProvider.getSigner(chain);
  const ethAdapter = new EthersAdapter({ ethers, signerOrProvider: signer });
  const txServiceUrl = getChain(chain).gnosisSafeTransactionServiceUrl;
  if (!txServiceUrl)
    throw new Error(`must provide tx service url for ${chain}`);
  return new SafeApiKit({ txServiceUrl, ethAdapter });
}

export function getSafe(
  chain: ChainName,
  multiProvider: MultiProvider,
  safeAddress: string,
): Promise<_Safe.default> {
  const signer = multiProvider.getSigner(chain);
  const ethAdapter = new EthersAdapter({ ethers, signerOrProvider: signer });
  return Safe.create({
    ethAdapter,
    safeAddress: safeAddress,
  });
}

export async function getSafeDelegates(
  service: _SafeApiKit.default,
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
