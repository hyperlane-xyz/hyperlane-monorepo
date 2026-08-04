import { ProtocolType, assert, isEVMLike } from '@hyperlane-xyz/utils';

import {
  BytecodeComparison,
  BytecodeValidity,
  compareBytecode,
} from '../deploy/verify/bytecodeComparator.js';
import type { BytecodeManifestSet } from '../deploy/verify/bytecodeManifest.js';
import type { MultiProvider } from '../providers/MultiProvider.js';
import type { ChainName } from '../types.js';
import type { WarpCoreConfig } from '../warp/types.js';

import { TokenStandard } from './TokenStandard.js';
import { TokenType } from './config.js';
import type { WarpRouteDeployConfig } from './types.js';

export interface WarpBytecodeComparison extends BytecodeComparison {
  chain: ChainName;
  label?: string;
  warpRouteId?: string;
}

export interface BytecodeMismatchViolation {
  module: string;
  warp_route_id: string;
  chain: ChainName;
  contract_name: string;
  type: 'BytecodeMismatch';
  sub_type: string;
  actual: string;
  expected: string;
}

type WarpBytecodeInput = WarpCoreConfig | WarpRouteDeployConfig;

interface WarpLeg {
  chainName: ChainName;
  addressOrDenom: string;
  standard?: TokenStandard;
  tokenType?: TokenType;
}

function isWarpCoreConfig(input: WarpBytecodeInput): input is WarpCoreConfig {
  return 'tokens' in input;
}

function getWarpLegs(input: WarpBytecodeInput): WarpLeg[] {
  if (isWarpCoreConfig(input)) {
    return input.tokens
      .filter((token) => token.addressOrDenom)
      .map((token) => ({
        chainName: token.chainName,
        addressOrDenom: token.addressOrDenom,
        standard: token.standard,
        tokenType: token.tokenType,
      }));
  }

  // Deploy configs generally do not include deployed router addresses. Support
  // only entries that carry an address-like override in future/local configs.
  return Object.entries(input).flatMap(([chainName, config]) => {
    const possibleAddress =
      'addressOrDenom' in config && typeof config.addressOrDenom === 'string'
        ? config.addressOrDenom
        : undefined;
    if (!possibleAddress) return [];
    return [
      {
        chainName,
        addressOrDenom: possibleAddress,
        tokenType: config.type,
      },
    ];
  });
}

const EXPECTED_BY_STANDARD: Partial<Record<TokenStandard, string>> = {
  [TokenStandard.EvmHypCollateral]: 'HypERC20Collateral',
  [TokenStandard.EvmHypNative]: 'HypNative',
  [TokenStandard.EvmHypSynthetic]: 'HypERC20',
  [TokenStandard.EvmHypCollateralFiat]: 'HypFiatToken',
  [TokenStandard.EvmHypOwnerCollateral]: 'HypERC4626OwnerCollateral',
  [TokenStandard.EvmHypRebaseCollateral]: 'HypERC4626Collateral',
  [TokenStandard.EvmHypSyntheticRebase]: 'HypERC20',
  [TokenStandard.EvmHypCrossCollateralRouter]: 'CrossCollateralRouter',
  [TokenStandard.EvmHypXERC20]: 'HypXERC20',
  [TokenStandard.EvmHypXERC20Lockbox]: 'HypXERC20Lockbox',
  [TokenStandard.EvmHypVSXERC20]: 'HypXERC20',
  [TokenStandard.EvmHypVSXERC20Lockbox]: 'HypXERC20Lockbox',
};

// Minimal deploy-type fallback. Prefer standards when present because they are
// closer to the runtime adapter semantics.
const EXPECTED_BY_TYPE: Partial<Record<TokenType, string>> = {
  [TokenType.collateral]: 'HypERC20Collateral',
  [TokenType.native]: 'HypNative',
  [TokenType.nativeScaled]: 'HypNative',
  [TokenType.synthetic]: 'HypERC20',
  [TokenType.syntheticRebase]: 'HypERC20',
  [TokenType.collateralFiat]: 'HypFiatToken',
  [TokenType.crossCollateral]: 'CrossCollateralRouter',
  [TokenType.XERC20]: 'HypXERC20',
  [TokenType.XERC20Lockbox]: 'HypXERC20Lockbox',
};

function expectedContractName(leg: WarpLeg): string | undefined {
  if (leg.standard) {
    const byStandard = EXPECTED_BY_STANDARD[leg.standard];
    if (byStandard) return byStandard;
  }
  return leg.tokenType ? EXPECTED_BY_TYPE[leg.tokenType] : undefined;
}

export async function checkWarpRouteBytecode(
  multiProvider: MultiProvider,
  warpConfig: WarpBytecodeInput,
  manifestSet: BytecodeManifestSet,
  opts?: { warpRouteId?: string },
): Promise<WarpBytecodeComparison[]> {
  const comparisons: WarpBytecodeComparison[] = [];
  for (const leg of getWarpLegs(warpConfig)) {
    const protocol = multiProvider.getProtocol(leg.chainName);
    if (!isEVMLike(protocol) || protocol === ProtocolType.Tron) continue;

    assert(leg.addressOrDenom, `Missing router address for ${leg.chainName}`);

    // Reverse-lookup (match against ANY known contract of the on-chain version)
    // is the validity trigger: a Mismatch then means the deployed bytecode does
    // not correspond to any version-controlled Hyperlane contract. The expected
    // name from the token standard is only advisory — the standard->name map
    // drifts across releases, so using it as the hard trigger produces false
    // violations when a route uses a validly-deployed but differently-named
    // contract (e.g. HypFiatToken, HypERC4626OwnerCollateral).
    const expected = expectedContractName(leg);
    const comparison = await compareBytecode(
      multiProvider.getProvider(leg.chainName),
      leg.addressOrDenom,
      manifestSet,
    );
    const typeMismatchNote =
      comparison.validity === BytecodeValidity.Match &&
      expected &&
      comparison.matchedContractName &&
      comparison.matchedContractName !== expected
        ? `on-chain contract ${comparison.matchedContractName} differs from expected ${expected} for standard`
        : undefined;
    comparisons.push({
      ...comparison,
      expectedContractName: expected,
      note: comparison.note ?? typeMismatchNote,
      chain: leg.chainName,
      label: `${leg.chainName}:${leg.addressOrDenom}`,
      warpRouteId: opts?.warpRouteId,
    });
  }
  return comparisons;
}

export function bytecodeComparisonsToViolations(
  comparisons: WarpBytecodeComparison[],
  warpRouteId: string,
): BytecodeMismatchViolation[] {
  return comparisons
    .filter((comparison) => comparison.validity === BytecodeValidity.Mismatch)
    .map((comparison) => ({
      module: 'warp',
      warp_route_id: warpRouteId,
      chain: comparison.chain,
      contract_name:
        comparison.expectedContractName ??
        comparison.matchedContractName ??
        comparison.address,
      type: 'BytecodeMismatch',
      sub_type: comparison.validity,
      actual: comparison.onchainMaskedHash ?? comparison.note ?? '',
      expected:
        comparison.expectedHash ?? comparison.expectedContractName ?? '',
    }));
}
