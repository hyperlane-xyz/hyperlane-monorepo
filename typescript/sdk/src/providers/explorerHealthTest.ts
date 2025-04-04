import { Address, ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import {
  getExplorerAddressUrl,
  getExplorerBaseUrl,
  getExplorerTxUrl,
} from '../metadata/blockExplorer.js';
import { ChainMetadata } from '../metadata/chainMetadataTypes.js';

const PROTOCOL_TO_ADDRESS: Record<ProtocolType, Address> = {
  [ProtocolType.Ethereum]: '0x0000000000000000000000000000000000000000',
  [ProtocolType.Sealevel]: '11111111111111111111111111111111',
  [ProtocolType.Cosmos]: 'cosmos100000000000000000000000000000000000000',
  [ProtocolType.CosmosNative]: 'cosmos100000000000000000000000000000000000000',
  [ProtocolType.Starknet]:
    '0x0000000000000000000000000000000000000000000000000000000000000000',
};

const PROTOCOL_TO_TX_HASH: Partial<Record<ProtocolType, Address>> = {
  [ProtocolType.Ethereum]:
    '0x0000000000000000000000000000000000000000000000000000000000000000',
  [ProtocolType.Cosmos]:
    '0000000000000000000000000000000000000000000000000000000000000000',
  [ProtocolType.CosmosNative]:
    '0000000000000000000000000000000000000000000000000000000000000000',
};

export async function isBlockExplorerHealthy(
  chainMetadata: ChainMetadata,
  explorerIndex: number,
  address?: Address,
  txHash?: string,
): Promise<boolean> {
  const baseUrl = getExplorerBaseUrl(chainMetadata, explorerIndex);
  address ??= PROTOCOL_TO_ADDRESS[chainMetadata.protocol];
  txHash ??= PROTOCOL_TO_TX_HASH[chainMetadata.protocol];

  if (!baseUrl) return false;
  rootLogger.debug(`Got base url: ${baseUrl}`);

  rootLogger.debug(`Checking explorer home for ${chainMetadata.name}`);
  await fetch(baseUrl);
  rootLogger.debug(`Explorer home exists for ${chainMetadata.name}`);

  if (address) {
    rootLogger.debug(
      `Checking explorer address page for ${chainMetadata.name}`,
    );
    const addressUrl = getExplorerAddressUrl(chainMetadata, address);
    if (!addressUrl) return false;
    rootLogger.debug(`Got address url: ${addressUrl}`);
    const addressReq = await fetch(addressUrl);
    if (!addressReq.ok && addressReq.status !== 404) return false;
    rootLogger.debug(`Explorer address page okay for ${chainMetadata.name}`);
  }

  if (txHash) {
    rootLogger.debug(`Checking explorer tx page for ${chainMetadata.name}`);
    const txUrl = getExplorerTxUrl(chainMetadata, txHash);
    if (!txUrl) return false;
    rootLogger.debug(`Got tx url: ${txUrl}`);
    const txReq = await fetch(txUrl);
    if (!txReq.ok && txReq.status !== 404) return false;
    rootLogger.debug(`Explorer tx page okay for ${chainMetadata.name}`);
  }

  return true;
}
