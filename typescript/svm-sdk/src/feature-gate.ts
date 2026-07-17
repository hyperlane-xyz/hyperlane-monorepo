import type { Address } from '@solana/kit';

import { eqAddressSol, isNullish } from '@hyperlane-xyz/utils';

import { FEATURE_GATE_PROGRAM_ADDRESS } from './constants.js';
import type { SvmRpc } from './types.js';

/** Minimal account-info shape read when decoding a feature gate account. */
type FeatureGateAccount = {
  owner: Address;
  data: readonly [string, string];
};

/**
 * Decodes whether a feature gate account represents an active feature.
 *
 * The on-chain account is a bincode `Feature { activated_at: Option<u64> }`;
 * byte 0 is the Option tag (1 = Some(slot) = active, 0 = None = pending).
 * A missing account or one not owned by the feature program is inactive.
 */
export function isActiveFeatureAccount(
  account: FeatureGateAccount | null,
): boolean {
  if (
    isNullish(account) ||
    !eqAddressSol(account.owner, FEATURE_GATE_PROGRAM_ADDRESS)
  ) {
    return false;
  }
  const data = Buffer.from(account.data[0], 'base64');
  return data.length >= 1 && data[0] === 1;
}

/**
 * Returns whether a Solana feature gate is active on the target cluster.
 *
 * Generic primitive: pass any feature gate account address.
 */
export async function isFeatureActive(
  rpc: SvmRpc,
  feature: Address,
): Promise<boolean> {
  const { value } = await rpc
    .getAccountInfo(feature, { encoding: 'base64' })
    .send();
  return isActiveFeatureAccount(value);
}
