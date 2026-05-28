import { Result } from '@ethersproject/abi';
import { BigNumber, ethers } from 'ethers';

import { eqAddress } from '@hyperlane-xyz/utils';

import { getAllSafesForChain } from '../../../../config/environments/mainnet3/governance/utils.js';
import { determineGovernanceType } from '../../../governance.js';
import { GovernanceType } from '../../../governanceTypes.js';
import { getSafeTx, parseSafeTx } from '../../../utils/safe.js';
import type { GovernTransaction, GovernanceDecoder } from '../types.js';
import { formatFunctionFragmentArgs } from '../utils.js';

export function createSafeDecoder(): GovernanceDecoder {
  return {
    id: 'safe',
    priority: 20,
    match: ({ chain, tx }) =>
      tx.to !== undefined &&
      getAllSafesForChain(chain).some((safe) => eqAddress(tx.to!, safe))
        ? true
        : undefined,
    decode: async ({ runtime, state, chain, tx }) => {
      if (!tx.data) {
        throw new Error('No data in Safe transaction');
      }

      if (!tx.to) {
        throw new Error('No to address in Safe transaction');
      }

      const decoded = parseSafeTx(tx);
      const args = formatFunctionFragmentArgs(
        decoded.args,
        decoded.functionFragment,
      );

      const { governanceType } = await determineGovernanceType(chain, tx.to);
      const toInsight = `${governanceType.toUpperCase()} Safe (${chain} ${
        tx.to
      })`;

      if (decoded.functionFragment.name === 'approveHash') {
        return readApproveHashTransaction(
          state,
          chain,
          args,
          toInsight,
          decoded.signature,
          governanceType,
        );
      }

      return readGeneralSafeTransaction(
        runtime.read,
        chain,
        decoded,
        args,
        toInsight,
      );
    },
  };
}

async function readApproveHashTransaction(
  state: Parameters<GovernanceDecoder['decode']>[0]['state'],
  chain: string,
  args: Record<string, any>,
  toInsight: string,
  signature: string,
  governanceType: GovernanceType,
): Promise<GovernTransaction> {
  const approvedTx = await getSafeTx(
    chain,
    state.multiProvider,
    args.hashToApprove,
  );

  const baseResult = {
    chain,
    to: toInsight,
    insight: `Approve hash: ${args.hashToApprove}`,
    args,
    signature,
  };

  if (!approvedTx) {
    return {
      ...baseResult,
      insight: `${baseResult.insight} (transaction not found)`,
    };
  }

  const reader = await state.createReader(state.environment, governanceType);

  const innerTx = await reader.read(chain, {
    to: approvedTx.to,
    data: approvedTx.data,
    value: BigNumber.from(approvedTx.value),
  });
  state.diagnostics.merge(reader.diagnostics);

  return {
    ...baseResult,
    nestedTx: innerTx,
  };
}

async function readGeneralSafeTransaction(
  read: (
    chain: string,
    tx: Parameters<GovernanceDecoder['decode']>[0]['tx'],
  ) => Promise<GovernTransaction>,
  chain: string,
  decoded: {
    functionFragment: ethers.utils.FunctionFragment;
    args: Result;
    signature: string;
  },
  args: Record<string, any>,
  toInsight: string,
): Promise<GovernTransaction> {
  let insight;
  let innerTx;
  switch (decoded.functionFragment.name) {
    case 'execTransaction': {
      innerTx = await read(chain, {
        to: args.to,
        data: args.data,
        value: args.value,
      });
      insight = `Execute transaction`;
      break;
    }
    case 'execTransactionFromModule': {
      innerTx = await read(chain, {
        to: args.to,
        data: args.data,
        value: args.value,
      });
      insight = `Execute transaction from module`;
      break;
    }
    case 'execTransactionFromModuleReturnData': {
      innerTx = await read(chain, {
        to: args.to,
        data: args.data,
        value: args.value,
      });
      insight = `Execute transaction from module with return data`;
      break;
    }
    case 'addOwnerWithThreshold':
      insight = `Add owner ${args.owner} with threshold ${args._threshold}`;
      break;
    case 'removeOwner':
      insight = `Remove owner ${args.owner} with new threshold ${args._threshold}`;
      break;
    case 'swapOwner':
      insight = `Swap owner ${args.oldOwner} with ${args.newOwner}`;
      break;
    case 'changeThreshold':
      insight = `Change threshold to ${args._threshold}`;
      break;
    case 'enableModule':
      insight = `Enable module ${args.module}`;
      break;
    case 'disableModule':
      insight = `Disable module ${args.module}`;
      break;
    case 'setGuard':
      insight = `Set guard to ${args.guard}`;
      break;
    case 'setFallbackHandler':
      insight = `Set fallback handler to ${args.handler}`;
      break;
    case 'setup':
      insight = `Setup Safe with ${args._owners.length} owners, threshold ${args._threshold}, fallback handler ${args.fallbackHandler}`;
      break;
    case 'simulateAndRevert':
      insight = `Simulate and revert transaction to ${args.targetContract}`;
      break;
  }

  return {
    chain,
    to: toInsight,
    insight: insight ?? '⚠️ Unknown Safe operation',
    signature: decoded.signature,
    ...(innerTx ? { nestedTx: innerTx } : {}),
    ...(insight ? {} : { args }),
  };
}
