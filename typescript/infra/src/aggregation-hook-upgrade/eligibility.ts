import type { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  ChainName,
  ChainTechnicalStack,
  isStaticDeploymentSupported,
} from '@hyperlane-xyz/sdk';
import { Address, ProtocolType } from '@hyperlane-xyz/utils';

import { SkipReason, SkipLists } from './types.js';

export interface EligibilityInput {
  chain: ChainName;
  protocol: ProtocolType;
  technicalStack?: ChainTechnicalStack;
  addresses?: ChainAddresses;
}

export type Eligibility =
  | { eligible: true; mailbox: Address; factory: Address }
  | { eligible: false; reason: SkipReason; detail: string };

export function checkEligibility(
  input: EligibilityInput,
  skipLists: SkipLists,
): Eligibility {
  const { chain, protocol, technicalStack, addresses } = input;
  const skip = (reason: SkipReason, detail: string): Eligibility => ({
    eligible: false,
    reason,
    detail,
  });

  if (protocol === ProtocolType.Tron) {
    return skip(SkipReason.Tron, `${chain} is a Tron chain`);
  }
  if (protocol !== ProtocolType.Ethereum) {
    return skip(SkipReason.NonEvm, `${chain} uses protocol ${protocol}`);
  }
  if (!isStaticDeploymentSupported(technicalStack)) {
    return skip(
      SkipReason.ZkSyncStack,
      `${chain} does not support static aggregation hooks`,
    );
  }
  if (skipLists.legacyCoreHookRecoveryChains.includes(chain)) {
    return skip(
      SkipReason.LegacyCoreHookRecovery,
      `${chain} runs a legacy core hook tree`,
    );
  }
  if (skipLists.chainsToSkip.includes(chain)) {
    return skip(SkipReason.ChainsToSkip, `${chain} is in chainsToSkip`);
  }

  const factory = addresses?.staticAggregationHookFactory;
  if (!factory) {
    return skip(
      SkipReason.NoRegistryFactory,
      `no staticAggregationHookFactory for ${chain} in the registry`,
    );
  }
  const mailbox = addresses?.mailbox;
  if (!mailbox) {
    return skip(
      SkipReason.NoMailbox,
      `no mailbox for ${chain} in the registry`,
    );
  }
  return { eligible: true, mailbox, factory };
}
