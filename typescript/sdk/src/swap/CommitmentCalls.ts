import { CallData, addressToBytes32, eqAddress } from '@hyperlane-xyz/utils';
import { BigNumber, BigNumberish, utils } from 'ethers';

import {
  IcaCommitment,
  RawCallData,
  buildIcaCommitment,
  normalizeCalls,
} from '../middleware/account/InterchainAccount.js';
import { Commands, encodeV3SwapExactIn } from './UniversalRouterEncoder.js';
import {
  DEFAULT_DEX_FLAVOR,
  DexFlavor,
  getDexFlavorIsUni,
  normalizePoolParam,
} from './types.js';

const ERC20_INTERFACE = new utils.Interface([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);

const WARP_ROUTE_INTERFACE = new utils.Interface([
  'function transferRemote(uint32 destinationDomain, bytes32 recipient, uint256 amount) payable returns (bytes32)',
]);

const UNIVERSAL_ROUTER_INTERFACE = new utils.Interface([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) external payable',
]);

function toOptionalValueString(value?: BigNumberish): string | undefined {
  if (value === undefined || value === null) return undefined;
  const asBn = BigNumber.from(value);
  return asBn.isZero() ? undefined : asBn.toString();
}

export function buildErc20ApproveCall(params: {
  token: string;
  spender: string;
  amount: BigNumberish;
}): RawCallData {
  return {
    to: params.token,
    data: ERC20_INTERFACE.encodeFunctionData('approve', [
      params.spender,
      params.amount,
    ]),
  };
}

export function buildErc20TransferCall(params: {
  token: string;
  recipient: string;
  amount: BigNumberish;
}): RawCallData {
  return {
    to: params.token,
    data: ERC20_INTERFACE.encodeFunctionData('transfer', [
      params.recipient,
      params.amount,
    ]),
  };
}

export function buildWarpTransferRemoteCall(params: {
  warpRoute: string;
  destinationDomain: number;
  recipient: string;
  amount: BigNumberish;
  msgFee?: BigNumberish;
}): RawCallData {
  return {
    to: params.warpRoute,
    data: WARP_ROUTE_INTERFACE.encodeFunctionData('transferRemote', [
      params.destinationDomain,
      addressToBytes32(params.recipient),
      params.amount,
    ]),
    value: toOptionalValueString(params.msgFee),
  };
}

export function buildUniversalRouterExecuteCall(params: {
  universalRouter: string;
  commands: string;
  inputs: string[];
  deadline: BigNumberish;
  value?: BigNumberish;
}): RawCallData {
  return {
    to: params.universalRouter,
    data: UNIVERSAL_ROUTER_INTERFACE.encodeFunctionData('execute', [
      params.commands,
      params.inputs,
      params.deadline,
    ]),
    value: toOptionalValueString(params.value),
  };
}

export function buildUniversalRouterV3SwapExactInCall(params: {
  universalRouter: string;
  recipient: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: BigNumberish;
  amountOutMinimum: BigNumberish;
  deadline: BigNumberish;
  payerIsUser?: boolean;
  poolParam?: number;
  dexFlavor?: DexFlavor;
  value?: BigNumberish;
}): RawCallData {
  if (eqAddress(params.tokenIn, params.tokenOut)) {
    throw new Error('tokenIn and tokenOut must differ for destination swap');
  }

  const poolParam = normalizePoolParam(params.poolParam);
  const isUni = getDexFlavorIsUni(params.dexFlavor ?? DEFAULT_DEX_FLAVOR);
  const path = utils.solidityPack(
    ['address', 'uint24', 'address'],
    [params.tokenIn, poolParam, params.tokenOut],
  );

  const command = encodeV3SwapExactIn({
    recipient: params.recipient,
    amountIn: BigNumber.from(params.amountIn),
    amountOutMinimum: BigNumber.from(params.amountOutMinimum),
    path,
    payerIsUser: params.payerIsUser ?? true,
    isUni,
  });

  return buildUniversalRouterExecuteCall({
    universalRouter: params.universalRouter,
    commands: utils.hexZeroPad(utils.hexlify(Commands.V3_SWAP_EXACT_IN), 1),
    inputs: [command.encodedInput],
    deadline: params.deadline,
    value: params.value,
  });
}

export type IcaCommitmentFromRawCalls = {
  normalizedCalls: CallData[];
} & IcaCommitment;

export function buildIcaCommitmentFromRawCalls(
  calls: RawCallData[],
  salt: string,
): IcaCommitmentFromRawCalls {
  if (calls.length === 0) {
    throw new Error('calls must contain at least one entry');
  }

  const normalizedCalls = normalizeCalls(calls);
  const commitment = buildIcaCommitment(normalizedCalls, salt);

  return {
    normalizedCalls,
    encodedCalls: commitment.encodedCalls,
    commitment: commitment.commitment,
  };
}
