import { utils } from 'ethers';
import { assert } from '@hyperlane-xyz/utils';
import type { BridgeQuote } from '../interfaces/IExternalBridge.js';
import {
  DLN_EVM_SOURCE,
  validateDeBridgeEvmTransaction,
} from './deBridgeValidation.js';

// UTB deployments: decentxyz/decent-contracts-v3@175f14d2bfaab5e04e698511f70aa023b774adec.
const UTB: Record<number, string> = {
  1: '0x1b6257CAE4192e62B629eFCa21771be3D759183D',
  42161: '0x5813877Cdda5F0f56EeaB9326A42804A09e2CD8c',
  8453: '0x0929222bC7Cc533aecC1ccFe9d9Bd6ecbB0CBF43',
};
// Mayan's documented Forwarder, and verified SwiftSource implementation.
// https://docs.mayan.finance/resources/chains-contracts
// https://etherscan.io/address/0x40fFE85A28DC9993541449464d7529a922142960#code
const MAYAN_FORWARDER = '0x337685fdaB40D39bd02028545a4FfA7D287cC3E2';
const MAYAN_SWIFT = '0x40fFE85A28DC9993541449464d7529a922142960';
const WORMHOLE_CHAINS: Record<number, number> = { 1: 2, 42161: 23, 8453: 30 };

export const SWAPS_UTB_INTERFACE = new utils.Interface([
  'function swapAndExecute(tuple(tuple(uint8 swapperId, tuple(uint256 amountIn, uint256 amountOut, uint256 dustOut, address tokenIn, address tokenOut, uint8 direction, address refund, bytes additionalArgs) swapParams) swapInstructions, address target, address paymentOperator, address refund, uint256 executionFee, bytes payload, bytes32 txId) instructions, tuple(bytes4 appId, bytes4 affiliateId, uint256 bridgeFee, uint256 deadline, uint256 chainId, tuple(address recipient, address token, uint256 amount)[] appFees) feeData, bytes signature) payable',
]);

export const MAYAN_FORWARDER_INTERFACE = new utils.Interface([
  'function forwardERC20(address tokenIn, uint256 amountIn, tuple(uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) permitParams, address mayanProtocol, bytes protocolData) payable',
]);

export const MAYAN_SWIFT_INTERFACE = new utils.Interface([
  'function createOrderWithToken(address tokenIn, uint256 amountIn, tuple(uint8 payloadType, bytes32 trader, bytes32 destAddr, uint16 destChainId, bytes32 referrerAddr, bytes32 tokenOut, uint64 minAmountOut, uint64 gasDrop, uint64 cancelFee, uint64 refundFee, uint64 deadline, uint8 referrerBps, uint8 auctionMode, bytes32 random) params, bytes customPayload) returns (bytes32 orderHash)',
]);

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const word = (address: string) => utils.hexZeroPad(address, 32).toLowerCase();
const canonical = (abi: utils.Interface, data: string) => {
  const call = abi.parseTransaction({ data });
  assert(
    same(abi.encodeFunctionData(call.functionFragment, call.args), data),
    'Noncanonical swaps.xyz bridge calldata',
  );
  return call.args;
};

/** Validate the entire supported call graph independently of API route labels. */
export async function validateSwapsEvmPayload(
  quote: BridgeQuote,
  tx: { to: string; data: string; value?: string },
  getDecimals: (chainId: number, token: string) => Promise<number>,
  maxRefundLossBps: number,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  const p = quote.requestParams;
  const recipient = p.toAddress ?? p.fromAddress;
  if (same(tx.to, DLN_EVM_SOURCE)) {
    validateDeBridgeEvmTransaction(
      { ...quote, requestParams: { ...p, toAddress: recipient } },
      tx.to,
      tx.data,
    );
    return;
  }
  assert(
    UTB[p.fromChain] && same(tx.to, UTB[p.fromChain]),
    'Unsupported swaps.xyz execution target; configured path requires a verified payload decoder',
  );
  const { instructions: i, feeData: fees } = canonical(
    SWAPS_UTB_INTERFACE,
    tx.data,
  );
  assert(
    BigInt(tx.value ?? '0') === 0n &&
      i.executionFee.isZero() &&
      fees.bridgeFee.isZero(),
    'Unsupported swaps.xyz native execution or bridge fee',
  );
  assert(
    fees.chainId.eq(p.fromChain) && fees.deadline.gt(now),
    'swaps.xyz fee chain or deadline mismatch',
  );
  assert(same(i.txId, quote.id), 'swaps.xyz transaction ID mismatch');
  const s = i.swapInstructions.swapParams;
  assert(
    i.swapInstructions.swapperId === 0 &&
      s.additionalArgs === '0x' &&
      same(s.tokenIn, p.fromToken) &&
      same(s.tokenOut, p.fromToken) &&
      s.amountIn.eq(s.amountOut) &&
      s.amountIn.gt(0) &&
      s.dustOut.isZero() &&
      (s.direction === 0 || s.direction === 1),
    'Unsupported swaps.xyz source swap or token flow',
  );
  assert(
    same(s.refund, p.fromAddress) && same(i.refund, p.fromAddress),
    'swaps.xyz refund recipient mismatch',
  );
  const sourceInput = BigInt(s.amountIn.toString());
  let debit = sourceInput;
  for (const fee of fees.appFees) {
    assert(
      same(fee.token, p.fromToken),
      'swaps.xyz fee spends an unrelated asset',
    );
    debit += fee.amount.toBigInt();
  }
  assert(
    debit <= quote.fromAmount,
    'swaps.xyz source and fees exceed accepted input',
  );
  assert(
    same(i.target, MAYAN_FORWARDER) && same(i.paymentOperator, MAYAN_FORWARDER),
    'Unsupported swaps.xyz nested bridge; configured path requires a verified payload decoder',
  );
  const forward = canonical(MAYAN_FORWARDER_INTERFACE, i.payload);
  assert(
    same(forward.tokenIn, p.fromToken) && forward.amountIn.eq(s.amountIn),
    'Mayan forwarded source input mismatch',
  );
  const permit = forward.permitParams;
  assert(
    permit.value.isZero() &&
      permit.deadline.isZero() &&
      permit.v === 0 &&
      BigInt(permit.r) === 0n &&
      BigInt(permit.s) === 0n,
    'Mayan permits are unsupported',
  );
  assert(
    same(forward.mayanProtocol, MAYAN_SWIFT),
    'Unsupported Mayan bridge contract',
  );
  const order = canonical(MAYAN_SWIFT_INTERFACE, forward.protocolData);
  const m = order.params;
  assert(
    same(order.tokenIn, p.fromToken) && order.amountIn.eq(s.amountIn),
    'Mayan order source input mismatch',
  );
  assert(
    m.payloadType === 1 &&
      order.customPayload === '0x' &&
      m.gasDrop.isZero() &&
      m.referrerBps === 0,
    'Mayan hooks, gas drops and referral fees are unsupported',
  );
  assert(
    m.trader.toLowerCase() === word(p.fromAddress) &&
      m.destAddr.toLowerCase() === word(recipient),
    'Mayan order recipient or refund trader mismatch',
  );
  assert(
    WORMHOLE_CHAINS[p.toChain] &&
      m.destChainId === WORMHOLE_CHAINS[p.toChain] &&
      m.tokenOut.toLowerCase() === word(p.toToken),
    'Mayan order destination route mismatch',
  );
  assert(
    m.deadline.gt(now) && m.deadline.lte(now + 86400),
    'Mayan order deadline outside one day',
  );
  const [fromDecimals, toDecimals] = await Promise.all([
    getDecimals(p.fromChain, p.fromToken),
    getDecimals(p.toChain, p.toToken),
  ]);
  assert(
    [fromDecimals, toDecimals].every(
      (d) => Number.isInteger(d) && d >= 0 && d <= 255,
    ),
    'Invalid on-chain token decimals',
  );
  const unit = (decimals: number) => 10n ** BigInt(Math.max(0, decimals - 8));
  assert(
    m.minAmountOut.toBigInt() * unit(toDecimals) >= quote.toAmountMin,
    'Mayan order output below accepted minimum',
  );
  const refundFees =
    (m.cancelFee.toBigInt() + m.refundFee.toBigInt()) * unit(fromDecimals);
  assert(
    (debit - sourceInput + refundFees) * 10000n <=
      quote.fromAmount * BigInt(maxRefundLossBps),
    'Mayan refund fees exceed accepted loss bound',
  );
}
