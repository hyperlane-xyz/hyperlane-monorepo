import { BigNumber, ethers } from 'ethers';

import type { GovernanceDecoder } from '../types.js';

export function createNativeTokenTransferDecoder(): GovernanceDecoder {
  return {
    id: 'native-token-transfer',
    priority: 140,
    match: ({ tx }) => (!tx.data && !!tx.value && !!tx.to ? true : undefined),
    decode: async ({ state, chain, tx }) => {
      const { symbol } = await state.multiProvider.getNativeToken(chain);
      const numTokens = ethers.utils.formatEther(tx.value ?? BigNumber.from(0));
      return {
        chain,
        insight: `Send ${numTokens} ${symbol} to ${tx.to}`,
      };
    },
  };
}
