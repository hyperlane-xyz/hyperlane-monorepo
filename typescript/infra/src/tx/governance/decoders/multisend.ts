import { ethers } from 'ethers';

import { eqAddress } from '@hyperlane-xyz/utils';

import { decodeMultiSendData } from '../../../utils/safe.js';
import type { GovernanceDecoder } from '../types.js';
import {
  formatOperationType,
  isRecoverableNestedDecodeError,
  metaTransactionDataToEV5Transaction,
  summarizeError,
} from '../utils.js';

export function createMultisendDecoder(): GovernanceDecoder {
  return {
    id: 'multisend',
    priority: 60,
    match: ({ state, tx }) => {
      if (tx.to === undefined) return undefined;

      return state.multiSendCallOnlyDeployments.some((addr) =>
        eqAddress(addr, tx.to!),
      ) || state.multiSendDeployments.some((addr) => eqAddress(addr, tx.to!))
        ? true
        : undefined;
    },
    decode: async ({ runtime, state, chain, tx }) => {
      if (!tx.data) {
        throw new Error('No data in multisend transaction');
      }
      const multisendDatas = decodeMultiSendData(tx.data);

      const { symbol } = await state.multiProvider.getNativeToken(chain);

      const multisends = await Promise.all(
        multisendDatas.map(async (multisend, index) => {
          try {
            const decoded = await runtime.read(
              chain,
              metaTransactionDataToEV5Transaction(multisend),
            );
            return {
              chain,
              index,
              value: `${ethers.utils.formatEther(multisend.value)} ${symbol}`,
              operation: formatOperationType(multisend.operation),
              decoded,
            };
          } catch (error: unknown) {
            if (!isRecoverableNestedDecodeError(error)) {
              throw error;
            }
            const summary = summarizeError(error);
            console.warn(
              `Failed to decode multisend at index ${index}: ${summary}`,
            );
            state.diagnostics.addWarning({
              chain,
              index,
              to: multisend.to,
              info: 'Could not decode nested multisend call',
              error: summary,
            });
            return {
              chain,
              index,
              value: `${ethers.utils.formatEther(multisend.value)} ${symbol}`,
              operation: formatOperationType(multisend.operation),
              decoded: {
                chain,
                insight: `⚠️ failed to decode (${summary})`,
                to: multisend.to,
                data: multisend.data,
              },
            };
          }
        }),
      );

      return {
        chain,
        multisends,
      };
    },
  };
}
