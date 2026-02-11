import { addressToBytes32, eqAddress } from '@hyperlane-xyz/utils';
import { BigNumber, constants, utils } from 'ethers';

import { SwapAndBridgeParams, UniversalRouterCommand } from './types.js';

export const Commands = {
  V3_SWAP_EXACT_IN: 0x00,
  WRAP_ETH: 0x0b,
  BRIDGE_TOKEN: 0x12,
  EXECUTE_CROSS_CHAIN: 0x13,
} as const;

export const BridgeTypes = {
  HYP_ERC20_COLLATERAL: 0x03,
} as const;

export type BridgeTokenParams = {
  bridgeType: number;
  recipient: string;
  token: string;
  bridge: string;
  amount: BigNumber;
  msgFee: BigNumber;
  tokenFee: BigNumber;
  domain: number;
  payerIsUser: boolean;
};

export type ExecuteCrossChainParams = {
  domain: number;
  icaRouter: string;
  remoteRouter: string;
  ism: string;
  commitment: string;
  msgFee: BigNumber;
  token: string;
  tokenFee: BigNumber;
  hook: string;
  hookMetadata: string;
};

export type V3SwapExactInParams = {
  recipient: string;
  amountIn: BigNumber;
  amountOutMinimum: BigNumber;
  path: string;
  payerIsUser: boolean;
};

export function encodeBridgeToken(
  params: BridgeTokenParams,
): UniversalRouterCommand {
  const encodedInput = utils.defaultAbiCoder.encode(
    [
      'uint8',
      'bytes32',
      'address',
      'address',
      'uint256',
      'uint256',
      'uint256',
      'uint32',
      'bool',
    ],
    [
      params.bridgeType,
      addressToBytes32(params.recipient),
      params.token,
      params.bridge,
      params.amount,
      params.msgFee,
      params.tokenFee,
      params.domain,
      params.payerIsUser,
    ],
  );

  return {
    commandType: Commands.BRIDGE_TOKEN,
    encodedInput,
  };
}

export function encodeExecuteCrossChain(
  params: ExecuteCrossChainParams,
): UniversalRouterCommand {
  const encodedInput = utils.defaultAbiCoder.encode(
    [
      'uint32',
      'address',
      'bytes32',
      'bytes32',
      'bytes32',
      'uint256',
      'address',
      'uint256',
      'address',
      'bytes',
    ],
    [
      params.domain,
      params.icaRouter,
      addressToBytes32(params.remoteRouter),
      addressToBytes32(params.ism),
      params.commitment,
      params.msgFee,
      params.token,
      params.tokenFee,
      params.hook || constants.AddressZero,
      params.hookMetadata || '0x',
    ],
  );

  return {
    commandType: Commands.EXECUTE_CROSS_CHAIN,
    encodedInput,
  };
}

export function encodeWrapEth(
  recipient: string,
  amount: BigNumber,
): UniversalRouterCommand {
  const encodedInput = utils.defaultAbiCoder.encode(
    ['address', 'uint256'],
    [recipient, amount],
  );
  return { commandType: Commands.WRAP_ETH, encodedInput };
}

export function encodeV3SwapExactIn(
  params: V3SwapExactInParams,
): UniversalRouterCommand {
  const encodedInput = utils.defaultAbiCoder.encode(
    ['address', 'uint256', 'uint256', 'bytes', 'bool'],
    [
      params.recipient,
      params.amountIn,
      params.amountOutMinimum,
      params.path,
      params.payerIsUser,
    ],
  );

  return {
    commandType: Commands.V3_SWAP_EXACT_IN,
    encodedInput,
  };
}

export function buildSwapAndBridgeTx(params: SwapAndBridgeParams): {
  commands: string;
  inputs: string[];
  value: BigNumber;
} {
  const encodedCommands: UniversalRouterCommand[] = [];
  const bridgeMsgFee = params.bridgeMsgFee ?? BigNumber.from(0);
  const bridgeTokenFee = params.bridgeTokenFee ?? BigNumber.from(0);
  const crossChainMsgFee = params.crossChainMsgFee ?? BigNumber.from(0);
  const crossChainTokenFee = params.crossChainTokenFee ?? BigNumber.from(0);

  const hasSwap = !eqAddress(params.originToken, params.bridgeToken);
  const isNative = params.isNativeOrigin ?? false;
  const swapOut = params.expectedSwapOutput ?? BigNumber.from(0);
  // Apply slippage to get the worst-case swap output we'll accept.
  // Bridge amount is based on this minimum so it never exceeds actual balance.
  const slippageBps = Math.floor((params.slippage ?? 0) * 10000);
  const swapOutMin = hasSwap
    ? swapOut.mul(10000 - slippageBps).div(10000)
    : BigNumber.from(0);

  if (hasSwap) {
    if (isNative) {
      encodedCommands.push(
        encodeWrapEth(params.universalRouterAddress, params.amount),
      );
    }

    const path = utils.solidityPack(
      ['address', 'uint24', 'address'],
      [params.originToken, 500, params.bridgeToken],
    );
    encodedCommands.push(
      encodeV3SwapExactIn({
        recipient: params.universalRouterAddress,
        amountIn: params.amount,
        amountOutMinimum: swapOutMin,
        path,
        payerIsUser: !isNative,
      }),
    );
  }

  // When hasSwap: bridge's transferRemote pulls (amount + internalFee) via transferFrom.
  // Use swapOutMin (slippage-adjusted) so bridge never exceeds actual swap output.
  // Any surplus above swapOutMin stays as dust in the router.
  const bridgeAmount = hasSwap ? swapOutMin.sub(bridgeTokenFee) : params.amount;
  const bridgeApproval = hasSwap ? swapOutMin : bridgeTokenFee;

  encodedCommands.push(
    encodeBridgeToken({
      bridgeType: BridgeTypes.HYP_ERC20_COLLATERAL,
      recipient: params.recipient,
      token: params.bridgeToken,
      bridge: params.warpRouteAddress,
      amount: bridgeAmount,
      msgFee: bridgeMsgFee,
      tokenFee: bridgeApproval,
      domain: params.destinationDomain,
      payerIsUser: !hasSwap,
    }),
  );

  encodedCommands.push(
    encodeExecuteCrossChain({
      domain: params.destinationDomain,
      icaRouter: params.icaRouterAddress,
      remoteRouter: params.remoteIcaRouterAddress,
      ism: params.ismAddress,
      commitment: params.commitment,
      msgFee: crossChainMsgFee,
      token: params.bridgeToken,
      tokenFee: crossChainTokenFee,
      hook: params.hook ?? constants.AddressZero,
      hookMetadata: params.hookMetadata ?? '0x',
    }),
  );

  const commands =
    '0x' +
    encodedCommands
      .map((command) =>
        utils.hexZeroPad(utils.hexlify(command.commandType), 1).slice(2),
      )
      .join('');

  let value = bridgeMsgFee.add(crossChainMsgFee);
  if (hasSwap && isNative) {
    value = value.add(params.amount);
  }

  return {
    commands,
    inputs: encodedCommands.map((command) => command.encodedInput),
    value,
  };
}
