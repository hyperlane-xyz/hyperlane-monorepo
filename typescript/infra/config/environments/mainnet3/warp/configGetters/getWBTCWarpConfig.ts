import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { Address, ProtocolType, assert } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { awIcas } from '../../governance/ica/aw.js';
import { awSafes } from '../../governance/safe/aw.js';
import { getWarpFeeOwner } from '../../governance/utils.js';
import { chainOwners, haggisDeployerKeyByProtocol } from '../../owners.js';
import {
  SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
  WARP_QUOTE_SIGNER,
} from '../consts.js';

import { getFixedRoutingFeeConfig } from './utils.js';

/**
 * WBTC — Abacus Works multi-collateral HWR (AW-695)
 *
 * Chains (all collateral, WBTC has 8 decimals everywhere):
 * - EVM:  ethereum, bsc
 * - TVM:  tron
 * - SVM:  solanamainnet
 *
 * Fee: 10 bps withdrawal fee on EVERY leg. Charged via a per-chain RoutingFee
 * whose per-destination contracts are OffchainQuotedLinearFee on all origins —
 * ethereum, bsc, tron AND solana. OffchainQuotedLinearFee is supported on
 * Ethereum, Tron and Sealevel, and a single secp256k1/H160 quote signer
 * authorises quotes across all three VMs (viem address == recovered H160). This
 * getter only deploys the fee contracts + quote-signer whitelist; the standing
 * withdrawal-fee quotes themselves are submitted post-deploy via
 * `hyperlane warp quote create` (no live quoting service required).
 *
 * Env-dynamic: the shared builder is parameterised on ownership, fee owners and
 * quote signers so the production (AW FPWR) and staging (Haggis deployer) getters
 * only differ in those inputs.
 */
export const evmDeploymentChains = ['ethereum', 'bsc'] as const;
export const tvmDeploymentChains = ['tron'] as const;
export const svmDeploymentChains = ['solanamainnet'] as const;

export const deploymentChains = [
  ...evmDeploymentChains,
  ...tvmDeploymentChains,
  ...svmDeploymentChains,
] as const;

// Every chain both charges the withdrawal fee (as origin) and is charged as a
// destination — including solana.
export const feeChains = deploymentChains;

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

// Staging: every contract (router + fee) is owned by the Haggis GCP deployer key
// so test changes are easy to make. The same secp256k1 secret backs the
// EVM/TVM address and its ed25519 pubkey backs the SVM address.
const HAGGIS_EVM_DEPLOYER = haggisDeployerKeyByProtocol[ProtocolType.Ethereum];
const HAGGIS_SVM_DEPLOYER = haggisDeployerKeyByProtocol[ProtocolType.Sealevel];
assert(HAGGIS_EVM_DEPLOYER, 'Missing Haggis EVM deployer key');
assert(HAGGIS_SVM_DEPLOYER, 'Missing Haggis SVM deployer key');

const stagingOwnersByChain: Record<DeploymentChain, string> = {
  ethereum: HAGGIS_EVM_DEPLOYER,
  bsc: HAGGIS_EVM_DEPLOYER,
  tron: HAGGIS_EVM_DEPLOYER,
  solanamainnet: HAGGIS_SVM_DEPLOYER,
};

const stagingFeeOwnersByChain: Record<FeeChain, string> = {
  ethereum: HAGGIS_EVM_DEPLOYER,
  bsc: HAGGIS_EVM_DEPLOYER,
  tron: HAGGIS_EVM_DEPLOYER,
  solanamainnet: HAGGIS_SVM_DEPLOYER,
};

export interface WBTCWarpConfigOptions {
  ownersByChain: Record<DeploymentChain, string>;
  // Fee owner per fee chain (production: dedicated warp-fee Safe/ICA on EVM/TVM,
  // AW Squads on solana; staging: deployer)
  feeOwnersByChain: Record<FeeChain, string>;
  // Optional per-chain RoutingFee beneficiary (who receives the collected fee).
  // Defaults to the fee owner on-chain when omitted.
  feeBeneficiariesByChain?: Partial<Record<FeeChain, string>>;
  // EIP-712 / secp256k1 quote signers for the OffchainQuotedLinearFee legs. A
  // single H160 signer is valid across EVM, tron and solana origins.
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
  beneficiary?: Address,
) =>
  getFixedRoutingFeeConfig(
    feeOwner,
    feeChains.filter((c) => c !== chain),
    WARP_FEE_BPS,
    undefined,
    quoteSigners,
    beneficiary,
  );

export const buildWBTCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  options: WBTCWarpConfigOptions,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const {
    ownersByChain,
    feeOwnersByChain,
    feeBeneficiariesByChain,
    quoteSigners,
    tokenMetadata = WBTC_TOKEN_METADATA,
    programIds,
  } = options;

  const configs: Array<[DeploymentChain, HypTokenRouterConfig]> = [];

  for (const chain of deploymentChains) {
    const feeOwner = feeOwnersByChain[chain];
    assert(feeOwner, `Missing fee owner for chain ${chain}`);

    const base: HypTokenRouterConfig = {
      type: TokenType.collateral,
      token: WBTC_COLLATERAL[chain],
      mailbox: routerConfig[chain].mailbox,
      owner: ownersByChain[chain],
      decimals: WBTC_DECIMALS,
      ...tokenMetadata,
      tokenFee: buildFeeConfig(
        chain,
        feeOwner,
        quoteSigners,
        feeBeneficiariesByChain?.[chain],
      ),
    };

    // SVM leg additionally carries the IGP hook + handler gas, and the built
    // program id once available.
    if (chain === 'solanamainnet') {
      configs.push([
        chain,
        {
          ...base,
          hook: SOLANA_IGP_ADDRESS,
          gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
          ...(programIds?.solanamainnet && {
            foreignDeployment: programIds.solanamainnet,
          }),
        },
      ]);
    } else {
      configs.push([chain, base]);
    }
  }

  return Object.fromEntries(configs);
};

// Production: AW FPWR ownership; fee owners are the dedicated warp-fee governance
// accounts (getWarpFeeOwner) on EVM/TVM, matching the other First Party HWRs.
// Solana has no dedicated warp-fee account, so its fee owner is the AW Squads
// route owner, while its fee beneficiary (who receives collected fees) is pinned
// to the Haggis solana deployer key.
export const getWBTCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> =>
  buildWBTCWarpConfig(routerConfig, {
    ownersByChain: productionOwnersByChain,
    feeOwnersByChain: {
      ethereum: getWarpFeeOwner('ethereum'),
      bsc: getWarpFeeOwner('bsc'),
      tron: getWarpFeeOwner('tron'),
      solanamainnet: chainOwners.solanamainnet.owner,
    },
    feeBeneficiariesByChain: {
      solanamainnet: HAGGIS_SVM_DEPLOYER,
    },
    quoteSigners: [WARP_QUOTE_SIGNER],
  });

// Staging (AW-737): every contract owned by the Haggis GCP deployer key. The
// deployer key is additionally authorised as a quote signer so fees can be
// re-quoted in staging without a production signer.
export const getWBTCSTAGEWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> =>
  buildWBTCWarpConfig(routerConfig, {
    ownersByChain: stagingOwnersByChain,
    feeOwnersByChain: stagingFeeOwnersByChain,
    quoteSigners: [WARP_QUOTE_SIGNER, HAGGIS_EVM_DEPLOYER],
  });
