import { BigNumber } from 'ethers';

export interface SwapAndBridgeParams {
  originToken: string;
  bridgeToken: string;
  destinationToken: string;
  amount: BigNumber;
  recipient: string;
  originDomain: number;
  destinationDomain: number;
  warpRouteAddress: string;
  icaRouterAddress: string;
  remoteIcaRouterAddress: string;
  universalRouterAddress: string;
  ismAddress: string;
  commitment: string;
  slippage: number;
  /** True when the user pays with native ETH (requires WRAP_ETH before swap) */
  isNativeOrigin?: boolean;
  bridgeMsgFee?: BigNumber;
  bridgeTokenFee?: BigNumber;
  crossChainMsgFee?: BigNumber;
  crossChainTokenFee?: BigNumber;
  hook?: string;
  hookMetadata?: string;
}

export interface UniversalRouterCommand {
  commandType: number;
  encodedInput: string;
}
