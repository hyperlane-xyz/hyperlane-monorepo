import { BigNumber, ethers, type providers } from 'ethers';

import type { MultiProvider } from '@hyperlane-xyz/sdk';
import { assert, eqAddress } from '@hyperlane-xyz/utils';

import {
  ArbitrumOrbitBridgeMode,
  type BridgeConfig,
  BridgeStack,
  type HyperlaneHookBridgeDelivery,
  OpStackBridgeMode,
} from '../config/types.js';

export const ARB_RETRYABLE_TX_ADDRESS =
  '0x000000000000000000000000000000000000006E';

const ARB_MESSAGE_KIND_SUBMIT_RETRYABLE = 9;
const ARB_MESSAGE_KIND_ETH_DEPOSIT = 12;

export const DELIVERY_EVENT_INTERFACES = {
  opStackPortal: new ethers.utils.Interface([
    'event TransactionDeposited(address indexed from, address indexed to, uint256 indexed version, bytes opaqueData)',
  ]),
  arbitrumBridge: new ethers.utils.Interface([
    'event MessageDelivered(uint256 indexed messageIndex, bytes32 indexed beforeInboxAcc, address inbox, uint8 kind, address sender, bytes32 messageDataHash, uint256 baseFeeL1, uint64 timestamp)',
  ]),
  arbitrumInboxEvents: new ethers.utils.Interface([
    'event InboxMessageDelivered(uint256 indexed messageNum, bytes data)',
  ]),
  arbitrumRetryablePrecompile: new ethers.utils.Interface([
    'event RedeemScheduled(bytes32 indexed ticketId, bytes32 indexed retryTxHash, uint64 indexed sequenceNum, uint64 donatedGas, address gasDonor, uint256 maxRefund, uint256 submissionFeeRefund)',
    'function getTimeout(bytes32 ticketId) view returns (uint256)',
    'error NoTicketWithID()',
  ]),
  hyperlaneMailboxEvents: new ethers.utils.Interface([
    'event Dispatch(address indexed sender, uint32 indexed destination, bytes32 indexed recipient, bytes message)',
    'event DispatchId(bytes32 indexed messageId)',
    'function delivered(bytes32 messageId) view returns (bool)',
  ]),
  hyperlaneMailboxClient: new ethers.utils.Interface([
    'function mailbox() view returns (address)',
  ]),
} as const;

export const NO_TICKET_WITH_ID_SELECTOR = ethers.utils
  .id('NoTicketWithID()')
  .slice(0, 10)
  .toLowerCase();

export enum BridgeDeliveryKind {
  OpStackDeposit = 'opStackDeposit',
  ArbitrumDeposit = 'arbitrumDeposit',
  ArbitrumRetryable = 'arbitrumRetryable',
  HyperlaneMessage = 'hyperlaneMessage',
}

export type BridgeDeliveryRef =
  | {
      kind: BridgeDeliveryKind.OpStackDeposit;
      l2TxHash: string;
    }
  | {
      kind: BridgeDeliveryKind.ArbitrumDeposit;
      childTxHash: string;
    }
  | {
      kind: BridgeDeliveryKind.ArbitrumRetryable;
      retryableCreationId: string;
    }
  | {
      kind: BridgeDeliveryKind.HyperlaneMessage;
      messageId: string;
      destinationMailboxAddress?: string;
    };

export type BridgeDeliveryStatus = 'pending' | 'delivered' | 'failed';

function formatRlpUint(value: BigNumber): Uint8Array {
  return ethers.utils.stripZeros(value.toHexString());
}

/**
 * Computes the canonical OP Stack Bedrock (type 0x7e) L2 deposit transaction
 * hash from an L1 OptimismPortal TransactionDeposited log.
 */
export function computeOpStackDepositTxHash(params: {
  l1BlockHash: string;
  l1LogIndex: number;
  from: string;
  to: string;
  opaqueData: string;
}): string {
  const { l1BlockHash, l1LogIndex, from, to, opaqueData } = params;
  const rawBytes = ethers.utils.arrayify(opaqueData);
  assert(
    rawBytes.length >= 32 + 32 + 8 + 1,
    `Invalid OP Stack TransactionDeposited opaqueData length: ${rawBytes.length}`,
  );

  const mint = BigNumber.from(ethers.utils.hexDataSlice(opaqueData, 0, 32));
  const value = BigNumber.from(ethers.utils.hexDataSlice(opaqueData, 32, 64));
  const gas = BigNumber.from(ethers.utils.hexDataSlice(opaqueData, 64, 72));
  const isCreation = rawBytes[72] === 1;
  const data =
    rawBytes.length > 73 ? ethers.utils.hexDataSlice(opaqueData, 73) : '0x';

  const depositIdHash = ethers.utils.keccak256(
    ethers.utils.hexConcat([
      l1BlockHash,
      ethers.utils.zeroPad(BigNumber.from(l1LogIndex).toHexString(), 32),
    ]),
  );
  const sourceHash = ethers.utils.keccak256(
    ethers.utils.hexConcat([ethers.utils.zeroPad('0x00', 32), depositIdHash]),
  );

  const rlpFields: Array<string | Uint8Array> = [
    sourceHash,
    ethers.utils.getAddress(from),
    isCreation ? '0x' : ethers.utils.getAddress(to),
    formatRlpUint(mint),
    formatRlpUint(value),
    formatRlpUint(gas),
    new Uint8Array([]), // isSystemTransaction = false
    data,
  ];

  return ethers.utils.keccak256(
    ethers.utils.hexConcat(['0x7e', ethers.utils.RLP.encode(rlpFields)]),
  );
}

/**
 * Computes the canonical Arbitrum Nitro L2 deposit transaction hash (type 0x64)
 * for Inbox.depositEth / ERC20Inbox.depositERC20 (kind = 12).
 */
export function computeArbitrumDepositTxHash(params: {
  childChainId: number;
  messageNumber: BigNumber;
  fromAddress: string;
  toAddress: string;
  value: BigNumber;
}): string {
  const fields: Array<string | Uint8Array> = [
    formatRlpUint(BigNumber.from(params.childChainId)),
    ethers.utils.zeroPad(formatRlpUint(params.messageNumber), 32),
    ethers.utils.getAddress(params.fromAddress),
    ethers.utils.getAddress(params.toAddress),
    formatRlpUint(params.value),
  ];

  return ethers.utils.keccak256(
    ethers.utils.hexConcat(['0x64', ethers.utils.RLP.encode(fields)]),
  );
}

/**
 * Computes the canonical Arbitrum Nitro L2 submit-retryable transaction hash
 * (type 0x69) for Inbox / ERC20Inbox createRetryableTicket (kind = 9).
 */
export function computeArbitrumRetryableCreationId(params: {
  childChainId: number;
  fromAddress: string;
  messageNumber: BigNumber;
  parentBaseFee: BigNumber;
  destAddress: string;
  l2CallValue: BigNumber;
  l1Value: BigNumber;
  maxSubmissionFee: BigNumber;
  excessFeeRefundAddress: string;
  callValueRefundAddress: string;
  gasLimit: BigNumber;
  maxFeePerGas: BigNumber;
  data: string;
}): string {
  const destFormatted = eqAddress(
    params.destAddress,
    ethers.constants.AddressZero,
  )
    ? '0x'
    : ethers.utils.getAddress(params.destAddress);

  const fields: Array<string | Uint8Array> = [
    formatRlpUint(BigNumber.from(params.childChainId)),
    ethers.utils.zeroPad(formatRlpUint(params.messageNumber), 32),
    ethers.utils.getAddress(params.fromAddress),
    formatRlpUint(params.parentBaseFee),
    formatRlpUint(params.l1Value),
    formatRlpUint(params.maxFeePerGas),
    formatRlpUint(params.gasLimit),
    destFormatted,
    formatRlpUint(params.l2CallValue),
    ethers.utils.getAddress(params.callValueRefundAddress),
    formatRlpUint(params.maxSubmissionFee),
    ethers.utils.getAddress(params.excessFeeRefundAddress),
    params.data,
  ];

  return ethers.utils.keccak256(
    ethers.utils.hexConcat(['0x69', ethers.utils.RLP.encode(fields)]),
  );
}

function parseArbitrumRetryableEventData(eventData: string): {
  destAddress: string;
  l2CallValue: BigNumber;
  l1Value: BigNumber;
  maxSubmissionFee: BigNumber;
  excessFeeRefundAddress: string;
  callValueRefundAddress: string;
  gasLimit: BigNumber;
  maxFeePerGas: BigNumber;
  data: string;
} {
  const decoded = ethers.utils.defaultAbiCoder.decode(
    [
      'uint256',
      'uint256',
      'uint256',
      'uint256',
      'uint256',
      'uint256',
      'uint256',
      'uint256',
      'uint256',
    ],
    eventData,
  );

  const word = (idx: number): BigNumber => {
    const val: unknown = decoded[idx];
    assert(
      BigNumber.isBigNumber(val),
      `Invalid retryable message word at ${idx}`,
    );
    return val;
  };
  const addrFromWord = (idx: number): string =>
    ethers.utils.getAddress(
      ethers.utils.hexZeroPad(word(idx).toHexString(), 20),
    );

  const dataByteLen = word(8).toNumber();
  const data =
    dataByteLen > 0
      ? `0x${eventData.slice(eventData.length - dataByteLen * 2)}`
      : '0x';

  return {
    destAddress: addrFromWord(0),
    l2CallValue: word(1),
    l1Value: word(2),
    maxSubmissionFee: word(3),
    excessFeeRefundAddress: addrFromWord(4),
    callValueRefundAddress: addrFromWord(5),
    gasLimit: word(6),
    maxFeePerGas: word(7),
    data,
  };
}

export function extractBridgeDeliveryRefFromReceipt(params: {
  receipt: providers.TransactionReceipt;
  bridge: BridgeConfig;
  destinationChainId?: number;
  destinationMailboxAddress?: string;
}): BridgeDeliveryRef | undefined {
  const { receipt, bridge, destinationChainId, destinationMailboxAddress } =
    params;
  if (!Array.isArray(receipt.logs) || receipt.logs.length === 0) {
    return undefined;
  }

  const isHookMode =
    (bridge.stack === BridgeStack.OpStack &&
      bridge.mode === OpStackBridgeMode.HyperlaneHook) ||
    (bridge.stack === BridgeStack.ArbitrumOrbit &&
      bridge.mode === ArbitrumOrbitBridgeMode.HyperlaneHook);

  if (isHookMode) {
    const dispatchIdTopic =
      DELIVERY_EVENT_INTERFACES.hyperlaneMailboxEvents.getEventTopic(
        'DispatchId',
      );
    for (const log of receipt.logs) {
      if (log.topics[0] === dispatchIdTopic && log.topics[1]) {
        const resolvedMailbox =
          destinationMailboxAddress ??
          bridge.hookDelivery?.destinationMailboxAddress;
        return {
          kind: BridgeDeliveryKind.HyperlaneMessage,
          messageId: log.topics[1],
          ...(resolvedMailbox
            ? { destinationMailboxAddress: resolvedMailbox }
            : {}),
        };
      }
    }
    return undefined;
  }

  if (bridge.stack === BridgeStack.OpStack) {
    const depositTopic = DELIVERY_EVENT_INTERFACES.opStackPortal.getEventTopic(
      'TransactionDeposited',
    );
    for (const log of receipt.logs) {
      if (log.topics[0] === depositTopic) {
        const parsed = DELIVERY_EVENT_INTERFACES.opStackPortal.parseLog(log);
        const version: unknown = parsed.args.version;
        if (BigNumber.isBigNumber(version) && version.eq(0)) {
          const from: unknown = parsed.args.from;
          const to: unknown = parsed.args.to;
          const opaqueData: unknown = parsed.args.opaqueData;
          if (
            typeof from === 'string' &&
            typeof to === 'string' &&
            typeof opaqueData === 'string'
          ) {
            return {
              kind: BridgeDeliveryKind.OpStackDeposit,
              l2TxHash: computeOpStackDepositTxHash({
                l1BlockHash: log.blockHash || receipt.blockHash,
                l1LogIndex: log.logIndex,
                from,
                to,
                opaqueData,
              }),
            };
          }
        }
      }
    }
    return undefined;
  }

  if (destinationChainId === undefined) {
    return undefined;
  }

  const msgDeliveredTopic =
    DELIVERY_EVENT_INTERFACES.arbitrumBridge.getEventTopic('MessageDelivered');
  const inboxDeliveredTopic =
    DELIVERY_EVENT_INTERFACES.arbitrumInboxEvents.getEventTopic(
      'InboxMessageDelivered',
    );

  const inboxDataByMsgNum = new Map<string, string>();
  for (const log of receipt.logs) {
    if (log.topics[0] === inboxDeliveredTopic) {
      const parsed =
        DELIVERY_EVENT_INTERFACES.arbitrumInboxEvents.parseLog(log);
      const msgNum: unknown = parsed.args.messageNum;
      const data: unknown = parsed.args.data;
      if (BigNumber.isBigNumber(msgNum) && typeof data === 'string') {
        inboxDataByMsgNum.set(msgNum.toString(), data);
      }
    }
  }

  for (const log of receipt.logs) {
    if (log.topics[0] !== msgDeliveredTopic) {
      continue;
    }
    const parsed = DELIVERY_EVENT_INTERFACES.arbitrumBridge.parseLog(log);
    const messageIndex: unknown = parsed.args.messageIndex;
    const kind: unknown = parsed.args.kind;
    const sender: unknown = parsed.args.sender;
    const baseFeeL1: unknown = parsed.args.baseFeeL1;
    if (
      !BigNumber.isBigNumber(messageIndex) ||
      typeof kind !== 'number' ||
      typeof sender !== 'string' ||
      !BigNumber.isBigNumber(baseFeeL1)
    ) {
      continue;
    }

    const inboxData = inboxDataByMsgNum.get(messageIndex.toString());
    if (!inboxData) {
      continue;
    }

    if (kind === ARB_MESSAGE_KIND_ETH_DEPOSIT) {
      assert(
        inboxData.length >= 2 + 40 + 2,
        'Invalid Arbitrum ETH deposit event data',
      );
      const toAddress = ethers.utils.getAddress(`0x${inboxData.slice(2, 42)}`);
      const value = BigNumber.from(`0x${inboxData.slice(42)}`);
      return {
        kind: BridgeDeliveryKind.ArbitrumDeposit,
        childTxHash: computeArbitrumDepositTxHash({
          childChainId: destinationChainId,
          messageNumber: messageIndex,
          fromAddress: sender,
          toAddress,
          value,
        }),
      };
    }

    if (kind === ARB_MESSAGE_KIND_SUBMIT_RETRYABLE) {
      const retryableParams = parseArbitrumRetryableEventData(inboxData);
      return {
        kind: BridgeDeliveryKind.ArbitrumRetryable,
        retryableCreationId: computeArbitrumRetryableCreationId({
          childChainId: destinationChainId,
          fromAddress: sender,
          messageNumber: messageIndex,
          parentBaseFee: baseFeeL1,
          ...retryableParams,
        }),
      };
    }
  }

  return undefined;
}

function extractRevertHexData(error: unknown, depth = 0): string | undefined {
  if (depth > 3 || typeof error !== 'object' || error === null) {
    return undefined;
  }
  if (
    'data' in error &&
    typeof error.data === 'string' &&
    error.data.startsWith('0x')
  ) {
    return error.data;
  }
  if ('error' in error) {
    return extractRevertHexData(error.error, depth + 1);
  }
  return undefined;
}

function isNoTicketWithIdError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  if ('errorName' in error && error.errorName === 'NoTicketWithID') {
    return true;
  }
  const revertHex = extractRevertHexData(error);
  if (
    typeof revertHex === 'string' &&
    revertHex.toLowerCase().startsWith(NO_TICKET_WITH_ID_SELECTOR)
  ) {
    return true;
  }
  return false;
}

export async function resolveDestinationMailboxAddress(params: {
  destinationProvider: providers.Provider;
  destinationChain: string;
  hookDelivery: HyperlaneHookBridgeDelivery;
}): Promise<string> {
  const { destinationProvider, destinationChain, hookDelivery } = params;
  let mailboxAddress = hookDelivery.destinationMailboxAddress;

  if (!mailboxAddress) {
    const rawMailbox = await destinationProvider.call({
      to: hookDelivery.recipientAddress,
      data: DELIVERY_EVENT_INTERFACES.hyperlaneMailboxClient.encodeFunctionData(
        'mailbox',
      ),
    });
    const decodedMailbox =
      DELIVERY_EVENT_INTERFACES.hyperlaneMailboxClient.decodeFunctionResult(
        'mailbox',
        rawMailbox,
      );
    const candidate: unknown = decodedMailbox[0];
    assert(
      typeof candidate === 'string' &&
        ethers.utils.isAddress(candidate) &&
        !eqAddress(candidate, ethers.constants.AddressZero),
      `Destination recipient contract ${hookDelivery.recipientAddress} on ${destinationChain} did not return a valid Mailbox address; configure hookDelivery.destinationMailboxAddress explicitly`,
    );
    mailboxAddress = candidate;
  }

  const code = await destinationProvider.getCode(mailboxAddress);
  assert(
    typeof code === 'string' && code !== '0x' && code.length > 2,
    `Resolved destination Hyperlane Mailbox ${mailboxAddress} has no deployed contract code on ${destinationChain}`,
  );

  // Verify before dispatch that the resolved address implements `delivered(bytes32)`
  // and returns a decodable boolean so delivery reconciliation cannot wedge on a
  // misconfigured contract (such as pointing destinationMailboxAddress at the forwarder).
  const probeData =
    DELIVERY_EVENT_INTERFACES.hyperlaneMailboxEvents.encodeFunctionData(
      'delivered',
      [ethers.constants.HashZero],
    );
  const rawProbe = await destinationProvider.call({
    to: mailboxAddress,
    data: probeData,
  });
  const decodedProbe =
    DELIVERY_EVENT_INTERFACES.hyperlaneMailboxEvents.decodeFunctionResult(
      'delivered',
      rawProbe,
    );
  const probeDelivered: unknown = decodedProbe[0];
  assert(
    typeof probeDelivered === 'boolean',
    `Resolved destination Hyperlane Mailbox ${mailboxAddress} on ${destinationChain} did not return a boolean for delivered(bytes32)`,
  );

  return mailboxAddress;
}

/**
 * Validates that a candidate replacement receipt matches the original deposit's
 * recipient and bridged/transferred amount using protocol-emitted receipt logs.
 * Returns `false` if no verifiable protocol evidence is present.
 */
export function verifyReceiptMatchesDepositIntent(params: {
  receipt: providers.TransactionReceipt;
  txValue: BigNumber;
  funderAddress: string;
  recipient: string;
  expectedBridgedAmount: BigNumber;
  expectedOriginNativeValue: BigNumber;
  bridge?: BridgeConfig;
}): boolean {
  const {
    receipt,
    txValue,
    funderAddress,
    recipient,
    expectedBridgedAmount,
    expectedOriginNativeValue,
    bridge,
  } = params;

  if (!bridge || !Array.isArray(receipt.logs) || receipt.logs.length === 0) {
    return false;
  }

  const isHookMode =
    (bridge.stack === BridgeStack.OpStack &&
      bridge.mode === OpStackBridgeMode.HyperlaneHook) ||
    (bridge.stack === BridgeStack.ArbitrumOrbit &&
      bridge.mode === ArbitrumOrbitBridgeMode.HyperlaneHook);

  if (isHookMode) {
    if (!txValue.eq(expectedOriginNativeValue)) {
      return false;
    }
    const dispatchTopic =
      DELIVERY_EVENT_INTERFACES.hyperlaneMailboxEvents.getEventTopic(
        'Dispatch',
      );
    for (const log of receipt.logs) {
      if (log.topics[0] !== dispatchTopic) {
        continue;
      }
      const parsed =
        DELIVERY_EVENT_INTERFACES.hyperlaneMailboxEvents.parseLog(log);
      const sender: unknown = parsed.args.sender;
      const message: unknown = parsed.args.message;
      // Hyperlane v3 message layout: 77-byte header + 32-byte padded key address body (109 bytes)
      if (
        typeof sender === 'string' &&
        eqAddress(sender, funderAddress) &&
        typeof message === 'string' &&
        ethers.utils.hexDataLength(message) >= 109
      ) {
        const bodyRecipient = ethers.utils.getAddress(
          ethers.utils.hexDataSlice(message, 89, 109),
        );
        if (eqAddress(bodyRecipient, recipient)) {
          return true;
        }
      }
    }
    return false;
  }

  if (bridge.stack === BridgeStack.OpStack) {
    if (!txValue.eq(expectedOriginNativeValue)) {
      return false;
    }
    const depositTopic = DELIVERY_EVENT_INTERFACES.opStackPortal.getEventTopic(
      'TransactionDeposited',
    );
    for (const log of receipt.logs) {
      if (log.topics[0] !== depositTopic) {
        continue;
      }
      const parsed = DELIVERY_EVENT_INTERFACES.opStackPortal.parseLog(log);
      const version: unknown = parsed.args.version;
      const to: unknown = parsed.args.to;
      const opaqueData: unknown = parsed.args.opaqueData;
      if (
        BigNumber.isBigNumber(version) &&
        version.eq(0) &&
        typeof to === 'string' &&
        eqAddress(to, recipient) &&
        typeof opaqueData === 'string' &&
        ethers.utils.hexDataLength(opaqueData) >= 64
      ) {
        const mint = BigNumber.from(
          ethers.utils.hexDataSlice(opaqueData, 0, 32),
        );
        if (mint.eq(expectedBridgedAmount)) {
          return true;
        }
      }
    }
    return false;
  }

  const msgDeliveredTopic =
    DELIVERY_EVENT_INTERFACES.arbitrumBridge.getEventTopic('MessageDelivered');
  const inboxDeliveredTopic =
    DELIVERY_EVENT_INTERFACES.arbitrumInboxEvents.getEventTopic(
      'InboxMessageDelivered',
    );
  const inboxDataByMsgNum = new Map<string, string>();
  for (const log of receipt.logs) {
    if (log.topics[0] === inboxDeliveredTopic) {
      const parsed =
        DELIVERY_EVENT_INTERFACES.arbitrumInboxEvents.parseLog(log);
      const msgNum: unknown = parsed.args.messageNum;
      const data: unknown = parsed.args.data;
      if (BigNumber.isBigNumber(msgNum) && typeof data === 'string') {
        inboxDataByMsgNum.set(msgNum.toString(), data);
      }
    }
  }

  for (const log of receipt.logs) {
    if (log.topics[0] !== msgDeliveredTopic) {
      continue;
    }
    const parsed = DELIVERY_EVENT_INTERFACES.arbitrumBridge.parseLog(log);
    const messageIndex: unknown = parsed.args.messageIndex;
    const kind: unknown = parsed.args.kind;
    if (!BigNumber.isBigNumber(messageIndex) || typeof kind !== 'number') {
      continue;
    }
    const inboxData = inboxDataByMsgNum.get(messageIndex.toString());
    if (!inboxData) {
      continue;
    }

    if (kind === ARB_MESSAGE_KIND_ETH_DEPOSIT && inboxData.length >= 44) {
      const toAddress = ethers.utils.getAddress(`0x${inboxData.slice(2, 42)}`);
      const value = BigNumber.from(`0x${inboxData.slice(42)}`);
      if (eqAddress(toAddress, recipient) && value.eq(expectedBridgedAmount)) {
        return true;
      }
    }

    if (kind === ARB_MESSAGE_KIND_SUBMIT_RETRYABLE) {
      const retryableParams = parseArbitrumRetryableEventData(inboxData);
      if (
        eqAddress(retryableParams.destAddress, recipient) &&
        retryableParams.l2CallValue.eq(expectedBridgedAmount)
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Ethers v5's `@ethersproject/abstract-provider` omits `| null` on
 * `getTransactionReceipt` and `getBlock` even though JSON-RPC resolves `null`
 * for unmined transactions or missing blocks. Widen the return type cleanly.
 */
export async function fetchTransactionReceipt(
  provider: providers.Provider,
  txHash: string,
): Promise<providers.TransactionReceipt | null | undefined> {
  if (typeof provider.getTransactionReceipt !== 'function') {
    return undefined;
  }
  const receipt: providers.TransactionReceipt | null | undefined =
    await provider.getTransactionReceipt(txHash);
  return receipt;
}

export async function fetchBlock(
  provider: providers.Provider,
  blockTag: providers.BlockTag,
): Promise<providers.Block | null | undefined> {
  if (typeof provider.getBlock !== 'function') {
    return undefined;
  }
  const block: providers.Block | null | undefined =
    await provider.getBlock(blockTag);
  return block;
}

export async function checkBridgeDeliveryStatus(params: {
  multiProvider: MultiProvider;
  destinationChain: string;
  bridge?: BridgeConfig;
  deliveryRef: BridgeDeliveryRef;
}): Promise<BridgeDeliveryStatus> {
  const { multiProvider, destinationChain, bridge, deliveryRef } = params;
  const destinationProvider = multiProvider.getProvider(destinationChain);

  switch (deliveryRef.kind) {
    case BridgeDeliveryKind.OpStackDeposit: {
      const receipt = await fetchTransactionReceipt(
        destinationProvider,
        deliveryRef.l2TxHash,
      );
      if (receipt == null) {
        return 'pending';
      }
      return receipt.status === 0 ? 'failed' : 'delivered';
    }

    case BridgeDeliveryKind.ArbitrumDeposit: {
      const receipt = await fetchTransactionReceipt(
        destinationProvider,
        deliveryRef.childTxHash,
      );
      if (receipt == null) {
        return 'pending';
      }
      return receipt.status === 0 ? 'failed' : 'delivered';
    }

    case BridgeDeliveryKind.ArbitrumRetryable: {
      const creationReceipt = await fetchTransactionReceipt(
        destinationProvider,
        deliveryRef.retryableCreationId,
      );
      if (creationReceipt == null) {
        return 'pending';
      }
      if (creationReceipt.status === 0) {
        return 'failed';
      }

      const redeemTopic =
        DELIVERY_EVENT_INTERFACES.arbitrumRetryablePrecompile.getEventTopic(
          'RedeemScheduled',
        );
      for (const log of creationReceipt.logs) {
        if (
          eqAddress(log.address, ARB_RETRYABLE_TX_ADDRESS) &&
          log.topics[0] === redeemTopic &&
          log.topics[1]?.toLowerCase() ===
            deliveryRef.retryableCreationId.toLowerCase() &&
          log.topics[2]
        ) {
          const redeemReceipt = await fetchTransactionReceipt(
            destinationProvider,
            log.topics[2],
          );
          if (redeemReceipt?.status === 1) {
            return 'delivered';
          }
        }
      }

      const latestBlock = await fetchBlock(destinationProvider, 'latest');
      if (latestBlock == null) {
        return 'pending';
      }

      const timeoutCall =
        DELIVERY_EVENT_INTERFACES.arbitrumRetryablePrecompile.encodeFunctionData(
          'getTimeout',
          [deliveryRef.retryableCreationId],
        );

      try {
        const rawTimeout = await destinationProvider.call(
          {
            to: ARB_RETRYABLE_TX_ADDRESS,
            data: timeoutCall,
          },
          latestBlock.number,
        );
        const decodedTimeout =
          DELIVERY_EVENT_INTERFACES.arbitrumRetryablePrecompile.decodeFunctionResult(
            'getTimeout',
            rawTimeout,
          );
        const timeoutTimestamp: unknown = decodedTimeout[0];
        assert(
          BigNumber.isBigNumber(timeoutTimestamp),
          'Invalid ArbRetryableTx.getTimeout result',
        );
        if (BigNumber.from(latestBlock.timestamp).gt(timeoutTimestamp)) {
          return 'failed';
        }
        return 'pending';
      } catch (error) {
        if (!isNoTicketWithIdError(error)) {
          throw error;
        }
        // Ticket no longer exists in ArbRetryableTx (NoTicketWithID): check if
        // a manual redeem succeeded; otherwise the ticket expired and was pruned.
        const logs = await destinationProvider.getLogs({
          address: ARB_RETRYABLE_TX_ADDRESS,
          fromBlock: creationReceipt.blockNumber,
          topics: [redeemTopic, deliveryRef.retryableCreationId],
        });
        for (const log of logs) {
          if (log.topics[2]) {
            const redeemReceipt = await fetchTransactionReceipt(
              destinationProvider,
              log.topics[2],
            );
            if (redeemReceipt?.status === 1) {
              return 'delivered';
            }
          }
        }
        return 'failed';
      }
    }

    case BridgeDeliveryKind.HyperlaneMessage: {
      const mailboxAddress =
        deliveryRef.destinationMailboxAddress ??
        (bridge?.hookDelivery
          ? await resolveDestinationMailboxAddress({
              destinationProvider,
              destinationChain,
              hookDelivery: bridge.hookDelivery,
            })
          : undefined);

      assert(
        mailboxAddress,
        `Cannot verify Hyperlane message delivery on ${destinationChain} without destination Mailbox address`,
      );

      const rawDelivered = await destinationProvider.call({
        to: mailboxAddress,
        data: DELIVERY_EVENT_INTERFACES.hyperlaneMailboxEvents.encodeFunctionData(
          'delivered',
          [deliveryRef.messageId],
        ),
      });
      const decodedDelivered =
        DELIVERY_EVENT_INTERFACES.hyperlaneMailboxEvents.decodeFunctionResult(
          'delivered',
          rawDelivered,
        );
      const isDelivered: unknown = decodedDelivered[0];
      assert(
        typeof isDelivered === 'boolean',
        'Destination Mailbox.delivered returned a non-boolean result',
      );
      return isDelivered ? 'delivered' : 'pending';
    }
  }
}
