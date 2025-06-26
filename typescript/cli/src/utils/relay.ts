import { TransactionReceipt } from '@ethersproject/providers';

import { IRegistry } from '@hyperlane-xyz/registry';
import {
  DispatchedMessage,
  HookType,
  HyperlaneCore,
  HyperlaneRelayer,
  MultiProvider,
  SubmissionStrategy,
  TxSubmitterBuilder,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { log, logGreen } from '../logger.js';

/**
 * Workaround helper for bypassing bad hook derivation when self-relaying.
 */
export function stubMerkleTreeConfig(
  relayer: HyperlaneRelayer,
  chain: string,
  hookAddress: string,
  merkleAddress: string,
) {
  relayer.hydrate({
    hook: {
      [chain]: {
        [hookAddress]: {
          type: HookType.MERKLE_TREE,
          address: merkleAddress,
        },
      },
    },
    ism: {},
    backlog: [],
  });
}

export function canSelfRelay(
  selfRelay: boolean,
  config: SubmissionStrategy,
  transactionReceipts: Awaited<
    ReturnType<TxSubmitterBuilder<ProtocolType>['submit']>
  >,
): { relay: true; txReceipt: TransactionReceipt } | { relay: false } {
  if (!transactionReceipts) {
    return { relay: false };
  }

  const txReceipt = Array.isArray(transactionReceipts)
    ? transactionReceipts[0]
    : transactionReceipts;

  if (!txReceipt) {
    return {
      relay: false,
    };
  }

  // Extremely naive way to narrow the type
  if (!('cumulativeGasUsed' in txReceipt)) {
    return {
      relay: false,
    };
  }

  const canRelay =
    selfRelay &&
    config.submitter.type === TxSubmitterType.INTERCHAIN_ACCOUNT &&
    config.submitter.internalSubmitter.type === TxSubmitterType.JSON_RPC;

  if (!canRelay) {
    return { relay: false };
  }

  return {
    relay: canRelay,
    txReceipt,
  };
}

export type RunSelfRelayOptions = {
  core?: HyperlaneCore;
  multiProvider: MultiProvider<{}>;
  registry: IRegistry;
  txReceipt: TransactionReceipt;
  successMessage?: string;
};

export async function runSelfRelay({
  registry,
  multiProvider,
  txReceipt,
  core,
  successMessage,
}: RunSelfRelayOptions): Promise<void> {
  const chainAddresses = await registry.getAddresses();
  core = core ?? HyperlaneCore.fromAddressesMap(chainAddresses, multiProvider);

  const relayer = new HyperlaneRelayer({ core });

  const messageIndex: number = 0;
  const message: DispatchedMessage =
    HyperlaneCore.getDispatchedMessages(txReceipt)[messageIndex];

  const originChain = multiProvider.getChainName(message.parsed.origin);
  const hookAddress = await core.getSenderHookAddress(message);
  const merkleAddress = chainAddresses[originChain].merkleTreeHook;
  stubMerkleTreeConfig(relayer, originChain, hookAddress, merkleAddress);

  log('Attempting self-relay of message...');
  await relayer.relayMessage(txReceipt, messageIndex, message);
  logGreen(successMessage ?? 'Message was self relayed successfully');
}
