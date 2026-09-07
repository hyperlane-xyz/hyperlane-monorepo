import { ethers } from 'ethers';

import {
  assert,
  isAddressEvm,
  normalizeAddressEvm,
} from '@hyperlane-xyz/utils';

const ZERO_BYTES = '0x';

export const KATANA_CHAIN_ID = 747474;
export const ETHEREUM_CHAIN_ID = 1;

export const KATANA_FORWARD_CONFIG = {
  fromChainId: ETHEREUM_CHAIN_ID,
  toChainId: KATANA_CHAIN_ID,
  fromToken: normalizeAddressEvm('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
  toToken: normalizeAddressEvm('0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36'),
  vaultAddress: normalizeAddressEvm(
    '0x53E82ABbb12638F09d9e624578ccB666217a765e',
  ),
  composerAddress: normalizeAddressEvm(
    '0x8A35897fda9E024d2aC20a937193e099679eC477',
  ),
  shareOftAddress: normalizeAddressEvm(
    '0xb5bADA33542a05395d504a25885e02503A957Bb3',
  ),
  destinationShareOftAddress: normalizeAddressEvm(
    '0x807275727Dd3E640c5F2b5DE7d1eC72B4Dd293C0',
  ),
  dstEid: 30375,
  extraOptions: '0x000301001101000000000000000000000000000186a0',
  composeMsg: ZERO_BYTES,
  oftCmd: ZERO_BYTES,
} as const;

export const KATANA_REVERSE_CONFIG = {
  fromChainId: KATANA_CHAIN_ID,
  toChainId: ETHEREUM_CHAIN_ID,
  fromToken: normalizeAddressEvm('0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36'),
  toToken: normalizeAddressEvm('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
  shareTokenAddress: normalizeAddressEvm(
    '0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36',
  ),
  shareOftAddress: normalizeAddressEvm(
    '0x807275727Dd3E640c5F2b5DE7d1eC72B4Dd293C0',
  ),
  vaultAddress: normalizeAddressEvm(
    '0x53E82ABbb12638F09d9e624578ccB666217a765e',
  ),
  composerAddress: normalizeAddressEvm(
    '0x8A35897fda9E024d2aC20a937193e099679eC477',
  ),
  dstEid: 30101,
  extraOptions: '0x0003010013030000000000000000000000000000000c3500',
  receiveExtraOptions: '0x000301001101000000000000000000000000000186a0',
  oftCmd: ZERO_BYTES,
} as const;

export const OFT_ABI = [
  'event OFTSent(bytes32 indexed guid, uint32 dstEid, address indexed fromAddress, uint256 amountSentLD, uint256 amountReceivedLD)',
  'event OFTReceived(bytes32 indexed guid, uint32 srcEid, address indexed toAddress, uint256 amountReceivedLD)',
  'function quoteSend((uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd) sendParam, bool payInLzToken) view returns ((uint256 nativeFee,uint256 lzTokenFee) msgFee)',
  'function send((uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd) sendParam, (uint256 nativeFee,uint256 lzTokenFee) fee, address refundAddress) payable returns ((bytes32 guid,uint64 nonce,(uint256 nativeFee,uint256 lzTokenFee) fee) msgReceipt,(uint256 amountSentLD,uint256 amountReceivedLD) oftReceipt)',
  'function secondaryChainBalance() view returns (uint256)',
];

export const COMPOSER_ABI = [
  'event Sent(bytes32 indexed guid)',
  'event Deposited(bytes32 sender, bytes32 recipient, uint32 dstEid, uint256 assetAmt, uint256 shareAmt)',
  'event Redeemed(bytes32 sender, bytes32 recipient, uint32 dstEid, uint256 shareAmt, uint256 assetAmt)',
  'function depositAndSend(uint256 amount,(uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd) sendParam,address refundAddress) payable',
];

export const PREVIEW_ABI = [
  'function previewDeposit(uint256 assets) view returns (uint256 shares)',
  'function previewRedeem(uint256 shares) view returns (uint256 assets)',
];

export const ERC20_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

export const oftInterface = new ethers.utils.Interface(OFT_ABI);
export const composerInterface = new ethers.utils.Interface(COMPOSER_ABI);
export const previewInterface = new ethers.utils.Interface(PREVIEW_ABI);
export const erc20Interface = new ethers.utils.Interface(ERC20_ABI);

export type OftSendParam = {
  dstEid: number;
  to: string;
  amountLD: bigint;
  minAmountLD: bigint;
  extraOptions: string;
  composeMsg: string;
  oftCmd: string;
};

export type BuiltRead = {
  to: string;
  data: string;
};

export type BuiltCallTemplateArg = string | number;

export type BuiltCallTemplate = {
  to: string;
  function: string;
  args: BuiltCallTemplateArg[];
  note?: string;
};

export type BuiltTx = {
  to: string;
  data: string;
  value: bigint;
  valueSource?: string;
};

export type ApprovalTx = BuiltCallTemplate & {
  tokenAddress: string;
  spender: string;
  amount: bigint;
  data: string;
};

export type KatanaEthereumToKatanaArgs = {
  vaultAddress: string;
  composerAddress: string;
  shareOftAddress: string;
  underlyingTokenAddress: string;
  dstEid: number;
  recipient: string;
  amountLD: bigint;
  shareAmountLD?: bigint;
  minShareAmountLD?: bigint;
  refundAddress: string;
  extraOptions?: string;
  composeMsg?: string;
  oftCmd?: string;
};

export type KatanaToEthereumArgs = {
  vaultAddress: string;
  composerAddress: string;
  shareTokenAddress: string;
  shareOftAddress: string;
  dstEid: number;
  recipient: string;
  shareAmountLD: bigint;
  minShareAmountLD?: bigint;
  assetAmountLD?: bigint;
  minAssetAmountLD?: bigint;
  refundAddress: string;
  extraOptions?: string;
  receiveExtraOptions?: string;
  oftCmd?: string;
};

export type BuiltKatanaEthereumToKatana = {
  direction: 'ethereum-to-katana';
  vaultAddress: string;
  composerAddress: string;
  shareOftAddress: string;
  underlyingTokenAddress: string;
  dstEid: number;
  recipient: string;
  recipientBytes32: string;
  assetAmountLD: bigint;
  sendParam: OftSendParam;
  previewDepositRead: BuiltCallTemplate;
  quoteRead: BuiltRead;
  assetApproveTx: ApprovalTx;
  depositAndSendTx: BuiltTx;
};

export type BuiltKatanaToEthereum = {
  direction: 'katana-to-ethereum';
  vaultAddress: string;
  composerAddress: string;
  shareTokenAddress: string;
  shareOftAddress: string;
  recipient: string;
  recipientBytes32: string;
  composerBytes32: string;
  shareAmountLD: bigint;
  redemptionSendParam: OftSendParam;
  sendParam: OftSendParam;
  previewRedeemRead: BuiltCallTemplate;
  shareApproveTx: ApprovalTx;
  quoteRead: BuiltRead;
  sendTx: BuiltTx;
};

function normalizeHexBytes(value: string | undefined, label: string): string {
  const normalized = value?.trim() || ZERO_BYTES;
  assert(/^0x[0-9a-fA-F]*$/.test(normalized), `Invalid ${label}: ${value}`);
  assert(normalized.length % 2 === 0, `Invalid ${label} byte length: ${value}`);
  return normalized.toLowerCase();
}

export function normalizeAddress(value: string, label: string): string {
  const normalized = normalizeAddressEvm(value);
  assert(isAddressEvm(normalized), `Invalid ${label}: ${value}`);
  return normalized;
}

export function addressToBytes32(address: string): string {
  return `0x${normalizeAddress(address, 'address').slice(2).toLowerCase().padStart(64, '0')}`;
}

export function applySlippage(amount: bigint, slippage: number): bigint {
  assert(slippage >= 0 && slippage < 1, `Invalid slippage: ${slippage}`);
  const slippageBps = BigInt(Math.round(slippage * 10_000));
  return (amount * (10_000n - slippageBps)) / 10_000n;
}

export function buildSendParam(args: {
  dstEid: number;
  recipient: string;
  amountLD: bigint;
  minAmountLD: bigint;
  extraOptions?: string;
  composeMsg?: string;
  oftCmd?: string;
}): OftSendParam {
  return {
    dstEid: args.dstEid,
    to: addressToBytes32(args.recipient),
    amountLD: args.amountLD,
    minAmountLD: args.minAmountLD,
    extraOptions: normalizeHexBytes(args.extraOptions, 'extraOptions'),
    composeMsg: normalizeHexBytes(args.composeMsg, 'composeMsg'),
    oftCmd: normalizeHexBytes(args.oftCmd, 'oftCmd'),
  };
}

function quoteSendRead(oftAddress: string, sendParam: OftSendParam): BuiltRead {
  return {
    to: normalizeAddress(oftAddress, 'oftAddress'),
    data: oftInterface.encodeFunctionData('quoteSend', [sendParam, false]),
  };
}

function sendTxTemplate(args: {
  oftAddress: string;
  sendParam: OftSendParam;
  refundAddress: string;
}): BuiltTx {
  return {
    to: normalizeAddress(args.oftAddress, 'oftAddress'),
    data: oftInterface.encodeFunctionData('send', [
      args.sendParam,
      { nativeFee: 0, lzTokenFee: 0 },
      normalizeAddress(args.refundAddress, 'refundAddress'),
    ]),
    value: 0n,
    valueSource:
      'Set msg.value and fee.nativeFee from quoteSend.nativeFee; lzTokenFee stays 0',
  };
}

function depositAndSendTxTemplate(args: {
  composerAddress: string;
  assetAmountLD: bigint;
  sendParam: OftSendParam;
  refundAddress: string;
}): BuiltTx {
  return {
    to: normalizeAddress(args.composerAddress, 'composerAddress'),
    data: composerInterface.encodeFunctionData('depositAndSend', [
      args.assetAmountLD,
      args.sendParam,
      normalizeAddress(args.refundAddress, 'refundAddress'),
    ]),
    value: 0n,
    valueSource:
      'Set msg.value from quoteSend.nativeFee returned by the share OFT quote',
  };
}

export function encodeComposerComposeMsg(
  sendParam: OftSendParam,
  msgValue: bigint = 0n,
): string {
  return ethers.utils.defaultAbiCoder.encode(
    [
      'tuple(uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd)',
      'uint256',
    ],
    [sendParam, msgValue],
  );
}

export function buildKatanaEthereumToKatana(
  args: KatanaEthereumToKatanaArgs,
): BuiltKatanaEthereumToKatana {
  const vaultAddress = normalizeAddress(args.vaultAddress, 'vaultAddress');
  const composerAddress = normalizeAddress(
    args.composerAddress,
    'composerAddress',
  );
  const shareOftAddress = normalizeAddress(
    args.shareOftAddress,
    'shareOftAddress',
  );
  const underlyingTokenAddress = normalizeAddress(
    args.underlyingTokenAddress,
    'underlyingTokenAddress',
  );
  const recipient = normalizeAddress(args.recipient, 'recipient');
  const assetAmountLD = args.amountLD;
  const shareAmountLD = args.shareAmountLD ?? assetAmountLD;
  const sendParam = buildSendParam({
    dstEid: args.dstEid,
    recipient,
    amountLD: shareAmountLD,
    minAmountLD: args.minShareAmountLD ?? shareAmountLD,
    extraOptions: args.extraOptions,
    composeMsg: args.composeMsg,
    oftCmd: args.oftCmd,
  });

  const approvalData = erc20Interface.encodeFunctionData('approve', [
    composerAddress,
    assetAmountLD,
  ]);

  return {
    direction: 'ethereum-to-katana',
    vaultAddress,
    composerAddress,
    shareOftAddress,
    underlyingTokenAddress,
    dstEid: args.dstEid,
    recipient,
    recipientBytes32: sendParam.to,
    assetAmountLD,
    sendParam,
    previewDepositRead: {
      to: vaultAddress,
      function: 'previewDeposit',
      args: [assetAmountLD.toString()],
      note: 'Refresh expected shares before quoteSend/depositAndSend',
    },
    quoteRead: quoteSendRead(shareOftAddress, sendParam),
    assetApproveTx: {
      to: underlyingTokenAddress,
      function: 'approve',
      args: [composerAddress, assetAmountLD.toString()],
      tokenAddress: underlyingTokenAddress,
      spender: composerAddress,
      amount: assetAmountLD,
      data: approvalData,
      note: 'Approve the OVault composer for the exact asset amount',
    },
    depositAndSendTx: depositAndSendTxTemplate({
      composerAddress,
      assetAmountLD,
      sendParam,
      refundAddress: args.refundAddress,
    }),
  };
}

export function buildKatanaToEthereumCompose(
  args: KatanaToEthereumArgs,
): BuiltKatanaToEthereum {
  const vaultAddress = normalizeAddress(args.vaultAddress, 'vaultAddress');
  const composerAddress = normalizeAddress(
    args.composerAddress,
    'composerAddress',
  );
  const shareTokenAddress = normalizeAddress(
    args.shareTokenAddress,
    'shareTokenAddress',
  );
  const shareOftAddress = normalizeAddress(
    args.shareOftAddress,
    'shareOftAddress',
  );
  const recipient = normalizeAddress(args.recipient, 'recipient');
  const shareAmountLD = args.shareAmountLD;
  const assetAmountLD = args.assetAmountLD ?? shareAmountLD;

  const redemptionSendParam = buildSendParam({
    dstEid: args.dstEid,
    recipient,
    amountLD: assetAmountLD,
    minAmountLD: args.minAssetAmountLD ?? assetAmountLD,
    extraOptions: args.receiveExtraOptions,
    composeMsg: ZERO_BYTES,
    oftCmd: args.oftCmd,
  });

  const sendParam = buildSendParam({
    dstEid: args.dstEid,
    recipient: composerAddress,
    amountLD: shareAmountLD,
    minAmountLD: args.minShareAmountLD ?? shareAmountLD,
    extraOptions: args.extraOptions,
    composeMsg: encodeComposerComposeMsg(redemptionSendParam),
    oftCmd: args.oftCmd,
  });

  const approvalData = erc20Interface.encodeFunctionData('approve', [
    shareOftAddress,
    shareAmountLD,
  ]);

  return {
    direction: 'katana-to-ethereum',
    vaultAddress,
    composerAddress,
    shareTokenAddress,
    shareOftAddress,
    recipient,
    recipientBytes32: redemptionSendParam.to,
    composerBytes32: sendParam.to,
    shareAmountLD,
    redemptionSendParam,
    sendParam,
    previewRedeemRead: {
      to: vaultAddress,
      function: 'previewRedeem',
      args: [shareAmountLD.toString()],
      note: 'Refresh expected assets before rebuilding the compose payload',
    },
    shareApproveTx: {
      to: shareTokenAddress,
      function: 'approve',
      args: [shareOftAddress, shareAmountLD.toString()],
      tokenAddress: shareTokenAddress,
      spender: shareOftAddress,
      amount: shareAmountLD,
      data: approvalData,
      note: 'Approve Katana vault shares to the share OFT before send',
    },
    quoteRead: quoteSendRead(shareOftAddress, sendParam),
    sendTx: sendTxTemplate({
      oftAddress: shareOftAddress,
      sendParam,
      refundAddress: args.refundAddress,
    }),
  };
}
