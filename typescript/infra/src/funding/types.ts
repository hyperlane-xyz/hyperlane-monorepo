import { BaseAgentKey } from '../agents/keys.js';

export type FunderAddresses = {
  interchainGasPaymaster: string;
};

export interface FunderConfig {
  skipIgpClaim: boolean;
  fundingThresholdFactor: number;
}

export interface KeyFundingInfo {
  key: BaseAgentKey;
  desiredBalance: number;
}

export interface ChainFundingPlan {
  keysToFund: KeyFundingInfo[];
  igpClaimThreshold: number;
}
