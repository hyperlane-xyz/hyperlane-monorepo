import { ethers } from 'ethers';

import { isAddressEvm, normalizeAddressEvm } from '@hyperlane-xyz/utils';

export const FLUENT_CHAIN_ID = 25363;
export const ETHEREUM_CHAIN_ID = 1;

// Native-asset sentinel address used by IExternalBridge.getNativeTokenAddress()
// (matches the LiFi convention).
export const NATIVE_TOKEN_SENTINEL = ethers.constants.AddressZero;

// Both deployments are at identical addresses on L1 and L2.
export const FLUENT_BRIDGE_ADDRESS = normalizeAddressEvm(
  '0x9CAcf613fC29015893728563f423fD26dCdB8Ddc',
);
export const FLUENT_NATIVE_GATEWAY_ADDRESS = normalizeAddressEvm(
  '0x8976Ca4E0c8467097Da675399fB7DB454a1b56dd',
);

// MessageStatus enum returned by FluentBridge.getReceivedMessage(bytes32):
// 0 = None (not yet delivered)
// 1 = Failed (destination call reverted or out of gas)
// 2 = Success (destination call succeeded; asset moved to recipient)
// Verified empirically by mainnet round-trip on 2026-04-29.
export const MessageStatus = {
  None: 0,
  Failed: 1,
  Success: 2,
} as const;
export type MessageStatusValue =
  (typeof MessageStatus)[keyof typeof MessageStatus];

export const FLUENT_FORWARD_CONFIG = {
  fromChainId: ETHEREUM_CHAIN_ID,
  toChainId: FLUENT_CHAIN_ID,
  fromToken: NATIVE_TOKEN_SENTINEL,
  toToken: NATIVE_TOKEN_SENTINEL,
  nativeGatewayAddress: FLUENT_NATIVE_GATEWAY_ADDRESS,
  fluentBridgeAddress: FLUENT_BRIDGE_ADDRESS,
} as const;

export const FLUENT_REVERSE_CONFIG = {
  fromChainId: FLUENT_CHAIN_ID,
  toChainId: ETHEREUM_CHAIN_ID,
  fromToken: NATIVE_TOKEN_SENTINEL,
  toToken: NATIVE_TOKEN_SENTINEL,
  nativeGatewayAddress: FLUENT_NATIVE_GATEWAY_ADDRESS,
  fluentBridgeAddress: FLUENT_BRIDGE_ADDRESS,
} as const;

export const NATIVE_GATEWAY_ABI = [
  'function sendNativeTokens(address to) payable',
  'function getOtherSideGateway() view returns (address)',
];

// `receiveMessageWithProof` is the relayer-side delivery path used for
// asset-bearing messages (selector 0x2731d657). Integrators do not call it;
// it appears here for documentation only.
export const FLUENT_BRIDGE_ABI = [
  'function sendMessage(address to, bytes message) payable',
  'function getReceivedMessage(bytes32 messageHash) view returns (uint8)',
  'function getSentMessageFee() view returns (uint256)',
  'event SentMessage(address indexed sender, address indexed to, uint256 value, uint256 fee, uint256 chainId, uint256 validUntilBlockNumber, uint256 nonce, bytes32 messageHash, bytes data)',
];

export const nativeGatewayInterface = new ethers.utils.Interface(
  NATIVE_GATEWAY_ABI,
);
export const fluentBridgeInterface = new ethers.utils.Interface(
  FLUENT_BRIDGE_ABI,
);

export const sentMessageTopic =
  fluentBridgeInterface.getEventTopic('SentMessage');

export type FluentDirection = 'ethereum-to-fluent' | 'fluent-to-ethereum';

export type FluentNativeBridgeArgs = {
  nativeGateway: string;
  recipient: string;
  amount: bigint;
  messageFee: bigint;
};

export type FluentExecutionTx = {
  to: string;
  data: string;
  value: bigint;
  chainId: number;
};

export function normalizeAddress(value: string, label: string): string {
  const normalized = normalizeAddressEvm(value);
  if (!isAddressEvm(normalized)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return normalized;
}

function buildSendNativeTokensTx(
  args: FluentNativeBridgeArgs,
  chainId: number,
): FluentExecutionTx {
  const nativeGateway = normalizeAddress(args.nativeGateway, 'nativeGateway');
  const recipient = normalizeAddress(args.recipient, 'recipient');
  if (args.amount <= 0n) {
    throw new Error(`Invalid amount: ${args.amount}`);
  }
  return {
    to: nativeGateway,
    data: nativeGatewayInterface.encodeFunctionData('sendNativeTokens', [
      recipient,
    ]),
    value: args.amount + args.messageFee,
    chainId,
  };
}

export function buildEthereumToFluentDeposit(
  args: FluentNativeBridgeArgs,
): FluentExecutionTx {
  return buildSendNativeTokensTx(args, ETHEREUM_CHAIN_ID);
}

export function buildFluentToEthereumWithdraw(
  args: FluentNativeBridgeArgs,
): FluentExecutionTx {
  return buildSendNativeTokensTx(args, FLUENT_CHAIN_ID);
}

/**
 * Parses a SentMessage log from a transaction receipt and returns the
 * messageHash. Returns undefined if no matching log is found.
 */
export function extractMessageHashFromReceipt(
  receipt: ethers.providers.TransactionReceipt,
): string | undefined {
  return extractSentMessageFromReceipt(receipt)?.messageHash;
}

/**
 * Parses a SentMessage log and returns the messageHash plus the bridged
 * amount (gross msg.value minus the bridge fee — i.e., what actually crosses
 * to the destination). Returns undefined if no matching log is found.
 */
export function extractSentMessageFromReceipt(
  receipt: ethers.providers.TransactionReceipt,
): { messageHash: string; bridgedAmount: bigint } | undefined {
  for (const log of receipt.logs) {
    if (log.topics[0] !== sentMessageTopic) continue;
    const parsed = fluentBridgeInterface.parseLog(log);
    const value = BigInt(parsed.args.value.toString());
    const fee = BigInt(parsed.args.fee.toString());
    return {
      messageHash: parsed.args.messageHash as string,
      bridgedAmount: value - fee,
    };
  }
  return undefined;
}
