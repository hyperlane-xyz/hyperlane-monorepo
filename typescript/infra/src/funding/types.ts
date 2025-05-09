import { BaseAgentKey } from '../agents/keys.js';

export type FundingAddresses = {
  interchainGasPaymaster: string;
};

export interface FundingConfig {
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
