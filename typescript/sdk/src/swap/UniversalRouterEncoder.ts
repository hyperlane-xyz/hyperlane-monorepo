import { addressToBytes32, eqAddress } from '@hyperlane-xyz/utils';
import { BigNumber, utils } from 'ethers';

import { SwapAndBridgeParams, UniversalRouterCommand } from './types.js';

export const Commands = {
  V3_SWAP_EXACT_IN: 0x00,
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
      'bytes',
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
      params.hook,
      params.hookMetadata,
    ],
  );

  return {
    commandType: Commands.EXECUTE_CROSS_CHAIN,
    encodedInput,
  };
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

  if (!eqAddress(params.originToken, params.bridgeToken)) {
    const path = utils.solidityPack(
      ['address', 'uint24', 'address'],
      [params.originToken, 500, params.bridgeToken],
    );
    encodedCommands.push(
      encodeV3SwapExactIn({
        recipient: params.universalRouterAddress,
        amountIn: params.amount,
        amountOutMinimum: BigNumber.from(0),
        path,
        payerIsUser: true,
      }),
    );
  }

  encodedCommands.push(
    encodeBridgeToken({
      bridgeType: BridgeTypes.HYP_ERC20_COLLATERAL,
      recipient: params.recipient,
      token: params.bridgeToken,
      bridge: params.warpRouteAddress,
      amount: params.amount,
      msgFee: bridgeMsgFee,
      tokenFee: bridgeTokenFee,
      domain: params.destinationDomain,
      payerIsUser: true,
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
      hook: params.hook ?? '0x',
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

  const value = bridgeMsgFee.add(crossChainMsgFee);

  return {
    commands,
    inputs: encodedCommands.map((command) => command.encodedInput),
    value,
  };
}
