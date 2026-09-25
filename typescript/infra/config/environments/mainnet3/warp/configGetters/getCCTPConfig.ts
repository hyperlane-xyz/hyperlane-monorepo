import {
  ChainMap,
  ChainName,
  ChainSubmissionStrategy,
  HypTokenRouterConfig,
  OwnableConfig,
  SubmitterMetadata,
  TokenType,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';
import { assert, objMap } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { awIcasLegacy } from '../../governance/ica/_awLegacy.js';
import { awIcas } from '../../governance/ica/aw.js';
import { awSafes } from '../../governance/safe/aw.js';
import { HAGGIS_DEPLOYER } from '../../owners.js';
import {
  FAST_FINALITY_THRESHOLD,
  FAST_TRANSFER_FEE_BPS,
  STANDARD_FINALITY_THRESHOLD,
  messageTransmitterV1Addresses,
  messageTransmitterV2Addresses,
  tokenMessengerV1Addresses,
  tokenMessengerV2Addresses,
  usdcTokenAddresses,
} from '../cctp.js';

const SERVICE_URL = 'https://offchain-lookup.services.hyperlane.xyz';

// The original CCTP V2 production legs were deployed at core 11.2.0. Legs added
// afterwards, and every staging leg (staging is redeployed freely), track the
// current core version. Pinning the wrong version makes `warp check`/`warp
// apply` fail: the getter must report the version actually on-chain.
const CONTRACT_VERSION_LEGACY = '11.2.0';
const CONTRACT_VERSION_LATEST = '12.1.0';

// Production legs deployed at the latest core version rather than 11.2.0.
const LATEST_VERSION_PRODUCTION_CHAINS = new Set<ChainName>(['arc']);

const getContractVersion = (
  chain: ChainName,
  environment: CctpEnvironment,
): string => {
  if (environment === 'staging') {
    return CONTRACT_VERSION_LATEST;
  }
  return LATEST_VERSION_PRODUCTION_CHAINS.has(chain)
    ? CONTRACT_VERSION_LATEST
    : CONTRACT_VERSION_LEGACY;
};

type CctpVersion = 'V1' | 'V2';
// production routes are owned by the AW ICAs/Safes; staging routes are owned by
// the Haggis deployer key so they can be iterated on without governance.
type CctpEnvironment = 'production' | 'staging';

// Route membership is declared explicitly and decoupled from the address maps
// in cctp.ts. Adding a chain's CCTP addresses there does not implicitly extend a
// deployed route; a chain joins a route only when it is listed here.
const CCTP_V1_CHAINS = Object.keys(tokenMessengerV1Addresses);

const CCTP_V2_CHAINS = [
  'ethereum',
  'avalanche',
  'optimism',
  'arbitrum',
  'base',
  'polygon',
  'unichain',
  'linea',
  'sonic',
  'worldchain',
  'sei',
  'hyperevm',
  'ink',
  'arc',
] as const satisfies ReadonlyArray<keyof typeof tokenMessengerV2Addresses>;

export const CCTP_CHAINS = CCTP_V1_CHAINS;

// TODO: remove this once the route has been updated to be owned by non-legacy ownership
const v1Owners: Record<ChainName, string> = {
  arbitrum: '0xaB547e6cde21a5cC3247b8F80e6CeC3a030FAD4A',
  avalanche: awIcasLegacy['avalanche'],
  base: '0xA6D9Aa3878423C266480B5a7cEe74917220a1ad2',
  ethereum: awSafes['ethereum'],
  optimism: '0x20E9C1776A9408923546b64D5ea8BfdF0B7319d6',
  polygon: awIcasLegacy['polygon'],
  unichain: awIcasLegacy['unichain'],
};

// Ownership is declared explicitly per leg. Every V2 leg is owned by its AW
// ICA except the ethereum home Safe. optimism's v2 ICA is intentionally left
// commented out of the shared awIcas map (governance/ica/aw.ts) but already
// owns the USDC/eclipsemainnet optimism leg, so it is pinned literally here.
const v2Owners: Record<ChainName, string> = {
  ethereum: awSafes['ethereum'],
  optimism: '0x1E2afA8d1B841c53eDe9474D188Cd4FcfEd40dDC',
  arbitrum: awIcas['arbitrum'],
  avalanche: awIcas['avalanche'],
  base: awIcas['base'],
  polygon: awIcas['polygon'],
  unichain: awIcas['unichain'],
  linea: awIcas['linea'],
  sonic: awIcas['sonic'],
  worldchain: awIcas['worldchain'],
  sei: awIcas['sei'],
  hyperevm: awIcas['hyperevm'],
  ink: awIcas['ink'],
  arc: awIcas['arc'],
};

const getOwner = (
  chain: string,
  version: CctpVersion,
  environment: CctpEnvironment,
): string | undefined => {
  if (environment === 'staging') {
    return HAGGIS_DEPLOYER;
  }
  // TODO: restore after V1 route has been updated
  return version === 'V1' ? v1Owners[chain] : v2Owners[chain];
};

const getCCTPWarpConfig = (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  version: CctpVersion,
  environment: CctpEnvironment,
): ChainMap<HypTokenRouterConfig> => {
  const messengerAddresses =
    version === 'V1' ? tokenMessengerV1Addresses : tokenMessengerV2Addresses;
  const transmitterAddresses =
    version === 'V1'
      ? messageTransmitterV1Addresses
      : messageTransmitterV2Addresses;
  const routeChains: string[] =
    version === 'V1' ? [...CCTP_V1_CHAINS] : [...CCTP_V2_CHAINS];

  const chains = (
    Object.keys(messengerAddresses) as Array<keyof typeof messengerAddresses>
  ).filter((chain) => routeChains.includes(chain));

  return Object.fromEntries(
    chains.map((chain) => {
      const owner = getOwner(chain, version, environment);
      assert(owner, `Owner not found for ${chain}`);
      const config: HypTokenRouterConfig = {
        owner,
        mailbox: routerConfig[chain].mailbox,
        type: TokenType.collateralCctp,
        token: usdcTokenAddresses[chain],
        messageTransmitter: transmitterAddresses[chain],
        tokenMessenger: messengerAddresses[chain],
        cctpVersion: version,
        urls: [`${SERVICE_URL}/cctp/getCctpAttestation`],
      };
      return [chain, config];
    }),
  );
};

export const getCCTPV1WarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
  _warpRouteId: string,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  return getCCTPWarpConfig(routerConfig, 'V1', 'production');
};

const getCCTPV2WarpConfig = (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  mode: 'fast' | 'standard',
  environment: CctpEnvironment,
): ChainMap<HypTokenRouterConfig> => {
  const baseConfig = getCCTPWarpConfig(routerConfig, 'V2', environment);
  return objMap(baseConfig, (chain, config) => {
    const maxFeeBps =
      mode === 'fast'
        ? (FAST_TRANSFER_FEE_BPS[chain as keyof typeof FAST_TRANSFER_FEE_BPS] ??
          0)
        : 0;
    const minFinalityThreshold =
      mode === 'fast' ? FAST_FINALITY_THRESHOLD : STANDARD_FINALITY_THRESHOLD;

    return {
      ...config,
      contractVersion: getContractVersion(chain, environment),
      maxFeeBps,
      minFinalityThreshold,
    };
  });
};

export const getCCTPV2FastWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
  _warpRouteId: string,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  return getCCTPV2WarpConfig(routerConfig, 'fast', 'production');
};

export const getCCTPV2StandardWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
  _warpRouteId: string,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  return getCCTPV2WarpConfig(routerConfig, 'standard', 'production');
};

export const getCCTPV2StandardStagingWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
  _warpRouteId: string,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  return getCCTPV2WarpConfig(routerConfig, 'standard', 'staging');
};

export const getCCTPV2FastStagingWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
  _warpRouteId: string,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  return getCCTPV2WarpConfig(routerConfig, 'fast', 'staging');
};

const safeChain = 'ethereum';
const icaOwner = awSafes[safeChain];
const safeSubmitter: SubmitterMetadata = {
  type: TxSubmitterType.GNOSIS_SAFE,
  chain: safeChain,
  safeAddress: icaOwner,
};

const icaChainsLegacy = Object.keys(awIcasLegacy);
// A V2 leg is submitted through the ethereum Safe's ICA unless it is routed
// directly through a native Safe. The ethereum home leg is Safe-owned. optimism's
// transferOwnership(-> ICA) has executed on-chain, so its leg is now ICA-owned
// like the rest; later owner-gated changes must go through the ICA submitter.
const v2NativeSafeChains = new Set<ChainName>();
const icaChainsV2 = Object.keys(v2Owners).filter(
  (chain) =>
    v2Owners[chain] !== awSafes[chain] && !v2NativeSafeChains.has(chain),
);

const getCCTPStrategyConfig = (
  version: CctpVersion = 'V1',
): ChainSubmissionStrategy => {
  const chains: string[] =
    version === 'V1' ? [...CCTP_V1_CHAINS] : [...CCTP_V2_CHAINS];

  // For V1, use legacy ICAs; for V2, use new ICAs
  const icaChains = version === 'V1' ? icaChainsLegacy : icaChainsV2;

  const submitterMetadata = chains.map((chain): SubmitterMetadata => {
    const hasIca = icaChains.includes(chain);
    if (!hasIca) {
      return {
        type: TxSubmitterType.GNOSIS_SAFE,
        chain,
        safeAddress: awSafes[chain],
      };
    }

    return {
      type: TxSubmitterType.INTERCHAIN_ACCOUNT,
      chain: safeChain,
      owner: icaOwner,
      destinationChain: chain,
      internalSubmitter: safeSubmitter,
    };
  });

  return Object.fromEntries(
    chains.map((chain, index) => [
      chain,
      { submitter: submitterMetadata[index] },
    ]),
  );
};

export const getCCTPV1StrategyConfig = (): ChainSubmissionStrategy => {
  return getCCTPStrategyConfig('V1');
};

export const getCCTPV2StrategyConfig = (): ChainSubmissionStrategy => {
  return getCCTPStrategyConfig('V2');
};
