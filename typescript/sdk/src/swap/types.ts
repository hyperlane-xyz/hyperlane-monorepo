import { BigNumber } from 'ethers';

export interface SwapQuote {
  originSwapOutput: BigNumber;
  originSwapRate: string;
  bridgeFee: BigNumber;
  destinationSwapOutput: BigNumber;
  destinationSwapRate: string;
  estimatedOutput: BigNumber;
  minimumReceived: BigNumber;
  slippage: number;
}

export interface BridgeQuote {
  fee: BigNumber;
  feeToken: string;
}

export interface TotalQuote {
  originSwap: SwapQuote;
  bridge: BridgeQuote;
  estimatedOutput: BigNumber;
  minimumReceived: BigNumber;
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
  icaRouterAddress: string;
  universalRouterAddress: string;
  slippage: number;
}

export interface UniversalRouterCommand {
  commandType: number;
  encodedInput: string;
}

export interface CommitmentParams {
  calls: Array<{ to: string; data: string; value: string }>;
  salt: string;
  originDomain: number;
  destinationDomain: number;
  owner: string;
  ismOverride?: string;
}

export interface IcaConfig {
  origin: number;
  destination: number;
  owner: string;
  routerAddress: string;
  ismAddress: string;
  userSalt?: string;
}
