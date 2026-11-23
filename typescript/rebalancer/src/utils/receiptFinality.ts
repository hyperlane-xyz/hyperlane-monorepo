import type { providers } from 'ethers';

import type { ChainMetadata } from '@hyperlane-xyz/sdk';
import { TronJsonRpcProvider } from '@hyperlane-xyz/tron-sdk/runtime';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

/** A receipt must satisfy both confirmation depth and the chain's finality boundary. */
export async function isReceiptFinalized(
  provider: providers.Provider,
  receipt: providers.TransactionReceipt,
  blocks: ChainMetadata['blocks'],
  protocol: ProtocolType,
): Promise<boolean> {
  const finality = blocks?.reorgPeriod ?? 32;
  const minimumConfirmations = Math.max(
    blocks?.confirmations ?? 1,
    typeof finality === 'number' ? finality : 1,
    1,
  );
  if (!(receipt.confirmations >= minimumConfirmations)) return false;
  if (protocol === ProtocolType.Tron) {
    assert(
      provider instanceof TronJsonRpcProvider,
      'Tron reconciliation requires a finalized-block provider',
    );
    return receipt.blockNumber <= (await provider.getFinalizedBlockNumber());
  }
  if (typeof finality === 'string') {
    const block = await provider.getBlock(finality);
    return block != null && receipt.blockNumber <= block.number;
  }
  return true;
}
