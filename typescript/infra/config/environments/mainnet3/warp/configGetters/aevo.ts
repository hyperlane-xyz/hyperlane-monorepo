import {
  AevoXERC20Limits,
  HookConfig,
  HookType,
  HypTokenRouterConfig,
  IsmConfig,
  IsmType,
  XERC20Type,
} from '@hyperlane-xyz/sdk';
import { Address, assert, toWei } from '@hyperlane-xyz/utils';

import { PAUSER } from '../../owners.js';

export const AEVO_ORIGIN_CHAINS = ['optimism', 'arbitrum', 'base'] as const;
export type AevoOriginChain = (typeof AEVO_ORIGIN_CHAINS)[number];
export type AevoChain = 'aevo' | AevoOriginChain;

// Per-chain owners of the routers and of their rate limited and fallback
// routing modules, shared by the Aevo USDC and WETH warp route getters.
export type AevoOwners = Record<AevoChain, Address>;

// Temporary owner of the deployed staging routes. Not the infra DEPLOYER.
export const AEVO_STAGING_OWNER: Address =
  '0x3f13C1351AC66ca0f4827c607a94c93c82AD0913';

export const AEVO_STAGING_OWNERS: AevoOwners = {
  aevo: AEVO_STAGING_OWNER,
  optimism: AEVO_STAGING_OWNER,
  arbitrum: AEVO_STAGING_OWNER,
  base: AEVO_STAGING_OWNER,
};

// TODO(aevo-prod-owner): placeholder, NOT a real owner. In prod each chain is
// owned by the ICA derived for Aevo's Ethereum Safe (Safe address pending),
// never an EOA. Replace the placeholder with those ICAs before any prod export
// or deploy.
const AEVO_PROD_OWNER_PLACEHOLDER =
  '0x000000000000000000000000000000000000dEaD';

export const AEVO_PROD_OWNERS: AevoOwners = {
  aevo: AEVO_PROD_OWNER_PLACEHOLDER,
  optimism: AEVO_PROD_OWNER_PLACEHOLDER,
  arbitrum: AEVO_PROD_OWNER_PLACEHOLDER,
  base: AEVO_PROD_OWNER_PLACEHOLDER,
};

// TODO(aevo-prod-authority): once Aevo has authorized the router on its token,
// `warp apply` with `authorized: false` revokes it, so flip this to
// `authorized: true`, with the cap, in the same change (split this constant per
// environment). Before that, `false` is a no-op.
export const AEVO_ROUTER_XERC20_LIMITS: AevoXERC20Limits = {
  type: XERC20Type.Aevo,
  authorized: false,
};

// Must equal the on-chain immutable DURATION of the rate limited hook and ISM.
// The SDK config types require it even though the schema defaults it to 1 day.
const AEVO_RATE_LIMIT_DURATION_SECONDS = 86_400n;

export interface AevoChainLimits {
  // Daily cap, in token units, on what the chain's hook lets out.
  hookAmount: string;
  // Daily cap, in token units, on what the chain's ISM lets in.
  ismAmount: string;
}

export interface AevoTokenLimits {
  decimals: number;
  byChain: Record<AevoChain, AevoChainLimits>;
}

export const AEVO_USDC_LIMITS: AevoTokenLimits = {
  decimals: 6,
  byChain: {
    aevo: { hookAmount: '125000', ismAmount: '100000' },
    optimism: { hookAmount: '20000', ismAmount: '125000' },
    arbitrum: { hookAmount: '75000', ismAmount: '125000' },
    base: { hookAmount: '20000', ismAmount: '125000' },
  },
};

export const AEVO_WETH_LIMITS: AevoTokenLimits = {
  decimals: 18,
  byChain: {
    aevo: { hookAmount: '1.5', ismAmount: '3' },
    optimism: { hookAmount: '3', ismAmount: '3' },
    arbitrum: { hookAmount: '3', ismAmount: '3' },
    base: { hookAmount: '3', ismAmount: '3' },
  },
};

/**
 * The amount in base units, rounded down to a multiple of the rate limit
 * duration, which is what the rate limited hook and ISM require of maxCapacity.
 */
export function getAevoMaxCapacity(amount: string, decimals: number): string {
  const baseUnits = BigInt(toWei(amount, decimals));
  const capacity =
    (baseUnits / AEVO_RATE_LIMIT_DURATION_SECONDS) *
    AEVO_RATE_LIMIT_DURATION_SECONDS;
  assert(
    capacity > 0n,
    `Rate limit of ${amount} at ${decimals} decimals is below one ${AEVO_RATE_LIMIT_DURATION_SECONDS}s duration unit`,
  );
  return capacity.toString();
}

export interface AevoSecurityConfig {
  hook: HookConfig;
  interchainSecurityModule: IsmConfig;
}

/**
 * The hook limits what the chain lets out per day. The ISM limits what it lets
 * in per day, and falls back to the mailbox default ISM for verification. The
 * ISM threshold equals its module count, so every module must pass.
 *
 * The pausable modules belong to PAUSER, the dedicated Turnkey key Hyperlane
 * keeps on pausable modules: pause() is signed solo, unpause() needs rootUser
 * approval. The other modules belong to the chain's route owner.
 */
export function getAevoSecurityConfig(
  chain: AevoChain,
  ownersByChain: AevoOwners,
  limits: AevoTokenLimits,
): AevoSecurityConfig {
  const owner = ownersByChain[chain];
  assert(owner, `Owner not found for chain ${chain}`);

  const { hookAmount, ismAmount } = limits.byChain[chain];

  return {
    hook: {
      type: HookType.AGGREGATION,
      hooks: [
        { type: HookType.PAUSABLE, owner: PAUSER, paused: false },
        {
          type: HookType.RATE_LIMITED,
          owner,
          maxCapacity: getAevoMaxCapacity(hookAmount, limits.decimals),
          duration: AEVO_RATE_LIMIT_DURATION_SECONDS,
        },
        { type: HookType.MAILBOX_DEFAULT },
      ],
    },
    interchainSecurityModule: {
      type: IsmType.AGGREGATION,
      threshold: 3,
      modules: [
        { type: IsmType.PAUSABLE, owner: PAUSER, paused: false },
        {
          type: IsmType.RATE_LIMITED,
          owner,
          maxCapacity: getAevoMaxCapacity(ismAmount, limits.decimals),
          duration: AEVO_RATE_LIMIT_DURATION_SECONDS,
        },
        { type: IsmType.FALLBACK_ROUTING, owner, domains: {} },
      ],
    },
  };
}

/**
 * Sets the security config for the chain on the leg, which is returned.
 */
export function applyAevoSecurity(
  leg: HypTokenRouterConfig,
  chain: AevoChain,
  ownersByChain: AevoOwners,
  limits: AevoTokenLimits,
): HypTokenRouterConfig {
  const security = getAevoSecurityConfig(chain, ownersByChain, limits);
  leg.hook = security.hook;
  leg.interchainSecurityModule = security.interchainSecurityModule;
  return leg;
}
