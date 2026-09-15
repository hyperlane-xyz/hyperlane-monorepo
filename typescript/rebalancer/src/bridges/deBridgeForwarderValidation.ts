import { Contract, type providers, utils } from 'ethers';

import { assert } from '@hyperlane-xyz/utils';

import type { BridgeQuote } from '../interfaces/IExternalBridge.js';

// https://docs.debridge.com/dln-details/overview/deployed-contracts
// BSC implementation: 0xce56012e880851baa234cd092af516a0fca9cfe3 (DeBridgeRouter).
export const DLN_FORWARDER = '0x663DC15D3C1aC63ff12E45Ab68FeA3F0a883C251';
export const ZERO_EX_ALLOWANCE_HOLDER =
  '0x0000000000001fF3684f28c67538d4D072C22734';
export const ZERO_EX_BSC_SETTLER = '0x2D9d6e538Bd3f22323932782aaf89446caCAF9d3';
export const ZERO_EX_DEPLOYER = '0x00000000000004533Fe15556B1E086BB1A72cEae';
const BSC_USDT = '0x55d398326f99059fF775485246999027B3197955';
const BSC_USDC = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';

export const DLN_FORWARDER_INTERFACE = new utils.Interface([
  'function strictlySwapAndCall(address srcTokenIn,uint256 srcAmountIn,bytes permit,address swapRouter,bytes swapData,address srcTokenOut,uint256 srcAmountOut,address refundRecipient,address target,bytes targetData) payable',
]);
export const ZERO_EX_ALLOWANCE_INTERFACE = new utils.Interface([
  'function exec(address operator,address token,uint256 amount,address target,bytes data) payable',
]);
export const ZERO_EX_SETTLER_INTERFACE = new utils.Interface([
  'function execute((address recipient,address buyToken,uint256 minAmountOut) slippage,bytes[] actions,bytes32 zid) payable returns(bool)',
]);
// 0xProject/0x-settler@25b9af0:
// ISettlerActions, core/PancakeInfinity, allowanceholder/AllowanceHolderBase.
// Includes the four-argument POSITIVE_SLIPPAGE used by the captured deployment.
export const ZERO_EX_ACTION_INTERFACE = new utils.Interface([
  'function TRANSFER_FROM(address recipient,((address token,uint256 amount) permitted,uint256 nonce,uint256 deadline) permit,bytes sig)',
  'function PANCAKE_INFINITY(address recipient,address sellToken,uint256 ppm,bool feeOnTransfer,uint256 hashMul,uint256 hashMod,bytes fills,uint256 amountOutMin)',
  'function POSITIVE_SLIPPAGE(address recipient,address token,uint256 expectedAmount,uint256 maxPpm)',
]);

const sameAddress = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase();

/** Reject paused/retired deployments as well as unknown calldata versions. */
export async function validateDeBridgeForwarderDeployment(
  provider: providers.Provider,
  data: string,
): Promise<void> {
  // The registry is independent of the quote API. A reverting ownerOf means
  // paused: do not fall back to prev on RPC or contract errors.
  const registry = new Contract(
    ZERO_EX_DEPLOYER,
    [
      'function ownerOf(uint256) view returns(address)',
      'function prev(uint128) view returns(address)',
    ],
    provider,
  );
  const current: string = await registry.ownerOf(2);
  assert(
    current !== '0x0000000000000000000000000000000000000000',
    '0x Settler is paused',
  );
  assert(
    sameAddress(current, ZERO_EX_BSC_SETTLER) ||
      sameAddress(await registry.prev(2), ZERO_EX_BSC_SETTLER),
    'Unsupported or retired 0x Settler deployment',
  );
  const outer = decodeCanonical(DLN_FORWARDER_INTERFACE, data).args;
  const allowance = decodeCanonical(
    ZERO_EX_ALLOWANCE_INTERFACE,
    outer.swapData,
  ).args;
  const swap = decodeCanonical(ZERO_EX_SETTLER_INTERFACE, allowance.data).args;
  const funding = decodeCanonical(
    ZERO_EX_ACTION_INTERFACE,
    swap.actions[0],
  ).args;
  const block = await provider.getBlock('latest');
  assert(
    block && funding.permit.deadline.gt(block.timestamp),
    'deBridge source swap funding deadline has expired',
  );
}

function decodeCanonical(iface: utils.Interface, data: string) {
  const decoded = iface.parseTransaction({ data });
  assert(
    iface
      .encodeFunctionData(decoded.functionFragment, decoded.args)
      .toLowerCase() === data.toLowerCase(),
    'Non-canonical deBridge source swap calldata',
  );
  return decoded;
}

/** A single USDT -> USDC fill, with no hooks or extra encoded hops. */
function validatePancakeFill(data: string): void {
  const bytes = Buffer.from(utils.arrayify(data));
  // Layout documented in core/PancakeInfinity.sol: ppm(3), price(20), key(1),
  // buy token(20), hook(20), manager(1), fee(3), parameters(32), hook length(3).
  assert(bytes.length === 103, 'Unsupported Pancake Infinity fill length');
  assert(
    bytes.readUIntBE(0, 3) === 1_000_000 && bytes[23] === 1,
    'Unsupported Pancake Infinity fill allocation or token packing',
  );
  assert(
    sameAddress(utils.hexlify(bytes.subarray(24, 44)), BSC_USDC),
    'Pancake Infinity output token mismatch',
  );
  assert(
    bytes.subarray(44, 64).every((value) => value === 0) &&
      bytes.readUIntBE(100, 3) === 0,
    'Pancake Infinity hooks are unsupported',
  );
  assert(bytes[64] <= 1, 'Unsupported Pancake Infinity pool manager');
}

function validateZeroExSwap(
  data: string,
  amountIn: bigint,
  minimumOut: bigint,
  signer: string,
): void {
  const allowance = decodeCanonical(ZERO_EX_ALLOWANCE_INTERFACE, data).args;
  assert(
    sameAddress(allowance.operator, ZERO_EX_BSC_SETTLER) &&
      sameAddress(allowance.target, ZERO_EX_BSC_SETTLER),
    'Unsupported 0x source swap operator or target',
  );
  assert(
    sameAddress(allowance.token, BSC_USDT) &&
      BigInt(allowance.amount.toString()) === amountIn,
    '0x source swap allowance mismatch',
  );
  const swap = decodeCanonical(ZERO_EX_SETTLER_INTERFACE, allowance.data).args;
  assert(
    sameAddress(swap.slippage.recipient, DLN_FORWARDER) &&
      sameAddress(swap.slippage.buyToken, BSC_USDC) &&
      BigInt(swap.slippage.minAmountOut.toString()) > 0n,
    '0x source swap output commitment mismatch',
  );
  // DeBridgeRouter independently checks its actual USDC balance delta against
  // minimumOut before creating the order. The aggregator may quote a weaker
  // minimum; it cannot weaken that atomic outer check.
  const actions: string[] = swap.actions;
  assert(
    actions.length >= 2 && actions.length <= 10,
    'Unsupported 0x action count',
  );
  const funding = decodeCanonical(ZERO_EX_ACTION_INTERFACE, actions[0]);
  assert(
    funding.name === 'TRANSFER_FROM',
    '0x source swap must begin with funding',
  );
  assert(
    sameAddress(funding.args.recipient, ZERO_EX_BSC_SETTLER) &&
      sameAddress(funding.args.permit.permitted.token, BSC_USDT) &&
      BigInt(funding.args.permit.permitted.amount.toString()) === amountIn &&
      funding.args.permit.nonce.isZero() &&
      funding.args.sig === '0x',
    'Invalid 0x source funding or permit',
  );

  let swaps = 0;
  let lastAllocation = 0n;
  for (let i = 1; i < actions.length; i++) {
    const action = decodeCanonical(ZERO_EX_ACTION_INTERFACE, actions[i]);
    const args = action.args;
    if (action.name === 'POSITIVE_SLIPPAGE') {
      assert(
        i === actions.length - 1 && swaps > 0,
        'Invalid 0x surplus action position',
      );
      assert(
        sameAddress(args.recipient, signer) &&
          sameAddress(args.token, BSC_USDC) &&
          BigInt(args.expectedAmount.toString()) >= minimumOut &&
          BigInt(args.maxPpm.toString()) <= 1_000_000n,
        'Invalid 0x source surplus recipient or amount',
      );
      continue;
    }
    assert(
      action.name === 'PANCAKE_INFINITY',
      'Unsupported 0x source swap action',
    );
    lastAllocation = BigInt(args.ppm.toString());
    assert(
      sameAddress(args.recipient, ZERO_EX_BSC_SETTLER) &&
        sameAddress(args.sellToken, BSC_USDT) &&
        lastAllocation > 0n &&
        lastAllocation <= 1_000_000n &&
        !args.feeOnTransfer &&
        args.hashMul.eq(2) &&
        args.hashMod.eq('0xffffffffffffffc5'),
      'Invalid Pancake Infinity source swap',
    );
    validatePancakeFill(args.fills);
    swaps++;
  }
  assert(
    swaps > 0 && lastAllocation === 1_000_000n,
    '0x swap must consume the source allocation',
  );
}

/** Validate the entire supported source path; the caller validates targetData as a DLN order. */
export function validateDeBridgeForwarder(
  quote: BridgeQuote,
  data: string,
  dlnSource: string,
): { data: string; token: string; amount: bigint } {
  assert(
    quote.requestParams.fromChain === 56,
    'Unsupported deBridge forwarder source chain',
  );
  const args = decodeCanonical(DLN_FORWARDER_INTERFACE, data).args;
  const amount = BigInt(args.srcAmountOut.toString());
  assert(
    sameAddress(args.srcTokenIn, quote.requestParams.fromToken) &&
      sameAddress(args.srcTokenIn, BSC_USDT) &&
      BigInt(args.srcAmountIn.toString()) === quote.fromAmount,
    'deBridge forwarder source token or amount mismatch',
  );
  assert(args.permit === '0x', 'deBridge forwarder permits are unsupported');
  assert(
    sameAddress(args.srcTokenOut, BSC_USDC) && amount > 0n,
    'Unsupported deBridge intermediate token or amount',
  );
  assert(
    sameAddress(args.refundRecipient, quote.requestParams.fromAddress),
    'deBridge source swap refund recipient mismatch',
  );
  assert(
    sameAddress(args.target, dlnSource),
    'deBridge nested target is not the DLN source',
  );
  assert(
    sameAddress(args.swapRouter, ZERO_EX_ALLOWANCE_HOLDER),
    'Unsupported deBridge source swap router',
  );
  validateZeroExSwap(
    args.swapData,
    quote.fromAmount,
    amount,
    quote.requestParams.fromAddress,
  );
  return { data: args.targetData, token: args.srcTokenOut, amount };
}
