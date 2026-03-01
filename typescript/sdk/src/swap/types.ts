import { BigNumber } from 'ethers';

export const DexFlavors = {
  UniswapV3: 'uniswap-v3',
  VelodromeSlipstream: 'velodrome-slipstream',
} as const;

export type DexFlavor = (typeof DexFlavors)[keyof typeof DexFlavors];

export const DEFAULT_DEX_FLAVOR: DexFlavor = DexFlavors.UniswapV3;
export const DEFAULT_POOL_PARAM = 500;

const UINT24_MAX = 0xffffff;

export function getDexFlavorIsUni(
  dexFlavor: DexFlavor = DEFAULT_DEX_FLAVOR,
): boolean {
  return dexFlavor === DexFlavors.UniswapV3;
}

export function normalizePoolParam(
  poolParam: number = DEFAULT_POOL_PARAM,
): number {
  if (!Number.isInteger(poolParam) || poolParam < 0 || poolParam > UINT24_MAX) {
    throw new Error(
      `poolParam must be a uint24 integer, received ${poolParam}`,
    );
  }
  return poolParam;
}

export interface SwapAndBridgeParams {
  originToken: string;
  bridgeToken: string;
  destinationToken: string;
  amount: BigNumber;
  recipient: string;
  originDomain: number;
  destinationDomain: number;
  warpRouteAddress: string;
  icaRouterAddress?: string;
  remoteIcaRouterAddress?: string;
  universalRouterAddress: string;
  ismAddress?: string;
  commitment?: string;
  includeCrossChainCommand?: boolean;
  slippage: number;
  poolParam?: number;
  dexFlavor?: DexFlavor;
  /** True when the user pays with native ETH (requires WRAP_ETH before swap) */
  isNativeOrigin?: boolean;
  /** Expected output from the swap, used to compute bridge amount minus token fee */
  expectedSwapOutput?: BigNumber;
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
