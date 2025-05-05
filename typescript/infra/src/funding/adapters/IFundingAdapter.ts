import 'ethers';

import { BaseAppAdapter } from '@hyperlane-xyz/sdk';
import { Numberish } from '@hyperlane-xyz/utils';

import { BaseAgentKey } from '../../agents/keys.js';
import { DeployEnvironment } from '../../config/environment.js';
import { FundableRole } from '../../roles.js';

/**
 * Interface for protocol-specific funding adapters
 * Extends BaseAppAdapter to leverage protocol-specific functionality
 */
export interface IFundingAdapter extends BaseAppAdapter {
  // Core methods that must be implemented by all adapters
  getBalance(address: string): Promise<Numberish>;
  fundKey(
    key: BaseAgentKey,
    desiredBalance: number,
    fundingThresholdFactor: number,
  ): Promise<void>;
  getFundingAmount(
    address: string,
    desiredBalance: number,
    fundingThresholdFactor: number,
    role: FundableRole,
  ): Promise<Numberish>;
  claimFromIgp(claimThreshold: number): Promise<void>;
  updateMetrics(environment: DeployEnvironment): Promise<void>;
}
