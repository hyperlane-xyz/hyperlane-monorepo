import Safe from '@gnosis.pm/safe-core-sdk';
import EthersAdapter from '@gnosis.pm/safe-ethers-lib';
import SafeServiceClient from '@gnosis.pm/safe-service-client';
import { ethers } from 'ethers';

import { ChainConnection, ChainName, chainMetadata } from '@abacus-network/sdk';

export function getSafeService(
  chain: ChainName,
  connection: ChainConnection,
): SafeServiceClient {
  const signer = connection.signer;
  if (!signer) throw new Error(`no signer found for ${chain}`);
  const ethAdapter = new EthersAdapter({ ethers, signer });
  const txServiceUrl = chainMetadata[chain].gnosisSafeTransactionServiceUrl;
  if (!txServiceUrl)
    throw new Error(`must provide tx service url for ${chain}`);
  return new SafeServiceClient({ txServiceUrl, ethAdapter });
}

export function getSafe(
  connection: ChainConnection,
  safeAddress: string,
): Promise<Safe> {
  const signer = connection.signer;
  if (!signer) throw new Error(`no signer found`);
  const ethAdapter = new EthersAdapter({ ethers, signer });
  return Safe.create({
    ethAdapter,
    safeAddress: safeAddress,
  });
}

export async function getSafeDelegates(
  service: SafeServiceClient,
  safe: string,
) {
  const delegateResponse = await service.getSafeDelegates(safe);
  return delegateResponse.results.map((r) => r.delegate);
}

export async function canProposeSafeTransactions(
  proposer: string,
  chain: ChainName,
  connection: ChainConnection,
  safeAddress: string,
): Promise<boolean> {
  const safeService = getSafeService(chain, connection);
  const safe = await getSafe(connection, safeAddress);
  const delegates = await getSafeDelegates(safeService, safeAddress);
  const owners = await safe.getOwners();
  return delegates.includes(proposer) || owners.includes(proposer);
}
