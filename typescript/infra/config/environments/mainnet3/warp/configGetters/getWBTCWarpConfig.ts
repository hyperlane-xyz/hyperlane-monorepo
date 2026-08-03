import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { Address, assert } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { awIcas } from '../../governance/ica/aw.js';
import { awSafes } from '../../governance/safe/aw.js';
import { getWarpFeeOwner } from '../../governance/utils.js';
import { chainOwners } from '../../owners.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';

import { getFixedRoutingFeeConfig } from './utils.js';

/**
 * WBTC — Abacus Works multi-collateral HWR (AW-695)
 *
 * Chains (all collateral, WBTC has 8 decimals everywhere):
 * - EVM:  ethereum, bsc
 * - TVM:  tron
 * - SVM:  solanamainnet
 *
 * Fee: 10 bps withdrawal fee. Charged on the EVM + tron lanes via a RoutingFee
 * whose per-destination contracts are OffchainQuotedLinearFee on EVM origins and
 * a plain LinearFee on tron (tron's fee contract charges the flat fee directly,
 * without an offchain quote — same as the eni/USDT route). The SVM (solana) leg
 * carries no tokenFee, matching the existing SVM-inclusive FPWR routes.
 *
 * Env-dynamic: the shared builder is parameterised on ownership, fee owners and
 * quote signers so the production (AW FPWR) and staging (Haggis deployer) getters
 * only differ in those inputs — see getWBTCSTAGEWarpConfig.ts.
 */
export const evmDeploymentChains = ['ethereum', 'bsc'] as const;
export const tvmDeploymentChains = ['tron'] as const;
export const svmDeploymentChains = ['solanamainnet'] as const;

// Chains that participate in the withdrawal fee (both charge it and are charged
// as destinations). SVM is intentionally excluded.
export const feeChains = ['ethereum', 'bsc', 'tron'] as const;

export const deploymentChains = [
  ...evmDeploymentChains,
  ...tvmDeploymentChains,
  ...svmDeploymentChains,
] as const;

export type DeploymentChain = (typeof deploymentChains)[number];
export type FeeChain = (typeof feeChains)[number];

const WBTC_DECIMALS = 8;

const WBTC_TOKEN_METADATA = { name: 'Wrapped BTC', symbol: 'WBTC' } as const;

const WARP_FEE_BPS = 10;

// Route-specific collateral addresses (per AW-695). Note: these are NOT the same
// as the generic `tokens` map entries — in particular bsc WBTC here
// (0x39665e85…) differs from tokens.bsc.WBTC (BTCB), so we pin them locally.
const WBTC_COLLATERAL: Record<DeploymentChain, string> = {
  ethereum: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
  bsc: '0x39665e85a68a4d7328b8799135E2ff301a0Ca86f',
  // TYhWwKpw43ENFWBTGpzLHn3882f2au7SMi (converted from base58 to hex)
  tron: '0xf95335a4d42db4b70a9688a393279f2c90fa1025',
  solanamainnet: '5XZw2LKTyrfvfiskJ78AMpackRjPcyCif1WhUsPDuVqQ',
};

// core-addresses.ts SVM_CORE_ADDRESSES, solana igpProgramId
const SOLANA_IGP_ADDRESS = 'BhNcatUDC2D5JTyeaqrdSukiVFsEHK7e3hVmKMztwefv';

const productionOwnersByChain: Record<DeploymentChain, string> = {
  ethereum: awSafes.ethereum, // AW SAFE / FPWR owner
  bsc: awIcas.bsc, // AW ICA
  tron: awIcas.tron, // AW ICA
  solanamainnet: chainOwners.solanamainnet.owner, // AW Squads
};

export interface WBTCWarpConfigOptions {
  ownersByChain: Record<DeploymentChain, string>;
  // Fee owner per fee chain (production: dedicated warp-fee Safe/ICA; staging: deployer)
  feeOwnersByChain: Record<FeeChain, string>;
  // EIP-712 quote signers for the OffchainQuotedLinearFee on EVM origins
  quoteSigners: string[];
  tokenMetadata?: { name: string; symbol: string };
  // SVM foreignDeployment program ids. Undefined until the SVM programs are built
  // (filled in by the deploy session).
  programIds?: { solanamainnet?: string };
}

const buildFeeConfig = (
  chain: FeeChain,
  feeOwner: Address,
  quoteSigners: string[],
) =>
  getFixedRoutingFeeConfig(
    feeOwner,
    feeChains.filter((c) => c !== chain),
    WARP_FEE_BPS,
    undefined,
    // tron's fee contract charges the flat fee directly, without an offchain quote
    chain === 'tron' ? undefined : quoteSigners,
  );

export const buildWBTCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  options: WBTCWarpConfigOptions,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const {
    ownersByChain,
    feeOwnersByChain,
    quoteSigners,
    tokenMetadata = WBTC_TOKEN_METADATA,
    programIds,
  } = options;

  const configs: Array<[DeploymentChain, HypTokenRouterConfig]> = [];

  // EVM + tron collateral legs (with withdrawal fee)
  for (const chain of feeChains) {
    const feeOwner = feeOwnersByChain[chain];
    assert(feeOwner, `Missing fee owner for chain ${chain}`);

    configs.push([
      chain,
      {
        type: TokenType.collateral,
        token: WBTC_COLLATERAL[chain],
        mailbox: routerConfig[chain].mailbox,
        owner: ownersByChain[chain],
        decimals: WBTC_DECIMALS,
        ...tokenMetadata,
        tokenFee: buildFeeConfig(chain, feeOwner, quoteSigners),
      },
    ]);
  }

  // SVM collateral leg (no tokenFee)
  configs.push([
    'solanamainnet',
    {
      type: TokenType.collateral,
      token: WBTC_COLLATERAL.solanamainnet,
      mailbox: routerConfig.solanamainnet.mailbox,
      owner: ownersByChain.solanamainnet,
      hook: SOLANA_IGP_ADDRESS,
      gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
      decimals: WBTC_DECIMALS,
      ...tokenMetadata,
      ...(programIds?.solanamainnet && {
        foreignDeployment: programIds.solanamainnet,
      }),
    },
  ]);

  return Object.fromEntries(configs);
};

// Production: AW FPWR ownership; fee owners are the dedicated warp-fee governance
// accounts (getWarpFeeOwner), matching the other First Party HWRs.
export const getWBTCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> =>
  buildWBTCWarpConfig(routerConfig, {
    ownersByChain: productionOwnersByChain,
    feeOwnersByChain: {
      ethereum: getWarpFeeOwner('ethereum'),
      bsc: getWarpFeeOwner('bsc'),
      tron: getWarpFeeOwner('tron'),
    },
    quoteSigners: [
      '0xEd1829805De615eEFC7303766D395Ea0a1B2b04d',
      '0x22EA0e66c9aFe2879135f4d16B5627454C53877e',
    ],
  });
