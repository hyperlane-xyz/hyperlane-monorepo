import path from 'node:path';
import { createHash } from 'node:crypto';

import type { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  type ChainMetadata,
  type HypTokenRouterConfig,
  type TokenFeeConfigInput,
  TokenFeeType,
  type WarpCoreConfig,
} from '@hyperlane-xyz/sdk';
import {
  addressToBytes32,
  assert,
  eqAddress,
  stringifyObject,
} from '@hyperlane-xyz/utils';
import { writeJson, writeYaml } from '@hyperlane-xyz/utils/fs';

import {
  BSC_PIECEWISE_USDC_DESTINATIONS,
  buildBscUsdtProductionTokenFee,
} from '../../config/environments/mainnet3/warp/configGetters/getUSDTCitreaMoonpayWarpConfig.js';

export const PRODUCTION_BSC_USDT_ROUTER =
  '0x050dcc964BCA53eF1A98A2347995cabC73cE25b9';
export const PRODUCTION_BSC_EXISTING_FEE_ROOT =
  '0x4c61a80406ee56DC3F1B92872895fD6Be7850741';
export const PRODUCTION_APPLY_ROUTE_ID = 'USDT/moonpay';

export const PRODUCTION_APPLY_ARTIFACT_PATHS = {
  manifest: 'manifest.json',
  metadata: 'registry/chains/bsc/metadata.yaml',
  addresses: 'registry/chains/bsc/addresses.yaml',
  warpRoute: 'registry/deployments/warp_routes/USDT/moonpay-config.yaml',
  applyConfig: 'registry/deployments/warp_routes/USDT/moonpay-deploy.yaml',
} as const;

export interface ProductionPiecewiseOverlay {
  destination: string;
  domain: number;
  targetRouter: string;
  targetRouterKey: string;
  oldLeaf: string;
}

export interface ProductionApplyManifest {
  version: 1;
  readOnlyBuilder: true;
  writesOnchain: false;
  origin: 'bsc';
  routeId: typeof PRODUCTION_APPLY_ROUTE_ID;
  sourceBlock: number;
  sourceRouter: string;
  sourceFeeRoot: string;
  gitCommit: string;
  applyConfigHash: string;
  fallbackBps: 15;
  overlayCount: 7;
  overlays: ProductionPiecewiseOverlay[];
  files: typeof PRODUCTION_APPLY_ARTIFACT_PATHS;
  registryMergeOrder: ['generated-artifact', 'base-registry'];
  requiresBaseRegistry: true;
  artifactScope: {
    metadataChains: ['bsc'];
    addressChains: ['bsc'];
    applyConfigChains: ['bsc'];
    warpRouteChains: ['bsc'];
  };
  strategies: {
    fork: string;
    forkSubmit: string;
    icaFile: string;
    futureLive: string;
  };
}

export interface ProductionApplyArtifact {
  applyConfig: { bsc: HypTokenRouterConfig };
  warpRoute: WarpCoreConfig;
  metadata: ChainMetadata;
  addresses: ChainAddresses;
  manifest: ProductionApplyManifest;
}

export interface ProductionApplyArtifactInput {
  currentConfig: HypTokenRouterConfig;
  sourceRoute: WarpCoreConfig;
  usdcRoute: WarpCoreConfig;
  metadata: ChainMetadata;
  addresses: ChainAddresses;
  sourceBlock: number;
  sourceFeeRoot: string;
  gitCommit: string;
  domainByDestination: Record<string, number>;
  oldRootPointers: ProductionPiecewiseOverlay[];
  desiredTokenFee?: TokenFeeConfigInput;
}

function requireRoutingFee(
  value: TokenFeeConfigInput | undefined,
  label: string,
): Extract<
  TokenFeeConfigInput,
  { type: typeof TokenFeeType.CrossCollateralRoutingFee }
> {
  assert(
    value?.type === TokenFeeType.CrossCollateralRoutingFee,
    `${label} must be CrossCollateralRoutingFee`,
  );
  return value;
}

export function overlayProductionPiecewiseEntries(
  currentConfig: HypTokenRouterConfig,
  usdcRoute: WarpCoreConfig,
  domainByDestination: Record<string, number>,
  oldRootPointers: ProductionPiecewiseOverlay[],
  desiredTokenFee: TokenFeeConfigInput = buildBscUsdtProductionTokenFee(),
): {
  config: HypTokenRouterConfig;
  overlays: ProductionPiecewiseOverlay[];
} {
  const current = requireRoutingFee(
    currentConfig.tokenFee,
    'Current BSC token fee',
  );
  const desired = requireRoutingFee(desiredTokenFee, 'Desired BSC token fee');
  assert(
    eqAddress(current.owner, desired.owner),
    `Current fee owner ${current.owner} does not match desired owner ${desired.owner}`,
  );

  const feeContracts = { ...current.feeContracts };
  const overlays: ProductionPiecewiseOverlay[] = [];
  for (const destination of BSC_PIECEWISE_USDC_DESTINATIONS) {
    const target = usdcRoute.tokens.find(
      ({ chainName }) => chainName === destination,
    );
    assert(
      target?.addressOrDenom,
      `Missing USDC/moonpay target for ${destination}`,
    );
    const targetRouterKey = addressToBytes32(target.addressOrDenom);
    const currentDestination = current.feeContracts[destination];
    const desiredDestination = desired.feeContracts[destination];
    const currentLeaf = currentDestination?.[targetRouterKey];
    const currentLeafRecord = currentLeaf as
      | (Record<string, unknown> & { type?: string })
      | undefined;
    assert(
      currentLeaf?.type === TokenFeeType.OffchainQuotedLinearFee &&
        currentLeafRecord?.address !== undefined &&
        typeof currentLeafRecord.address === 'string' &&
        currentLeafRecord.bps === 3 &&
        Array.isArray(currentLeafRecord.quoteSigners),
      `Current ${destination} USDC entry must be the expected 3 bps OffchainQuotedLinearFee`,
    );
    const desiredLeaf = desiredDestination?.[targetRouterKey];
    assert(
      desiredLeaf?.type === TokenFeeType.OffchainQuotedPiecewiseLinearFee &&
        'initialFallback' in desiredLeaf &&
        desiredLeaf.initialFallback.breakpoints.length === 0 &&
        desiredLeaf.initialFallback.marginalBps.length === 1 &&
        desiredLeaf.initialFallback.marginalBps[0] === 15,
      `Desired ${destination} USDC leaf must be flat 15 bps piecewise`,
    );
    feeContracts[destination] = {
      ...currentDestination,
      [targetRouterKey]: desiredLeaf,
    };
    const domain = domainByDestination[destination];
    assert(
      Number.isSafeInteger(domain) && domain > 0,
      `Missing domain for ${destination}`,
    );
    const oldPointer = oldRootPointers.find(
      (pointer) =>
        pointer.destination === destination &&
        pointer.domain === domain &&
        pointer.targetRouterKey.toLowerCase() === targetRouterKey.toLowerCase(),
    );
    assert(
      oldPointer && eqAddress(oldPointer.oldLeaf, currentLeafRecord.address),
      `Root pointer for ${destination} does not match current config leaf ${currentLeafRecord.address}`,
    );
    overlays.push({
      destination,
      domain,
      targetRouter: target.addressOrDenom,
      targetRouterKey,
      oldLeaf: oldPointer.oldLeaf,
    });
  }

  assert(overlays.length === 7, 'Expected exactly seven production overlays');
  return {
    config: {
      ...currentConfig,
      tokenFee: { ...current, feeContracts },
    },
    overlays,
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export function hashProductionApplyConfig(config: {
  bsc: HypTokenRouterConfig;
}): string {
  const normalized = JSON.parse(stringifyObject(config, 'json'));
  const canonical = JSON.stringify(canonicalize(normalized));
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export function buildProductionApplyArtifact(
  input: ProductionApplyArtifactInput,
): ProductionApplyArtifact {
  const sourceToken = input.sourceRoute.tokens.find(
    ({ chainName }) => chainName === 'bsc',
  );
  assert(
    sourceToken?.addressOrDenom &&
      eqAddress(sourceToken.addressOrDenom, PRODUCTION_BSC_USDT_ROUTER),
    `USDT/moonpay BSC router must be ${PRODUCTION_BSC_USDT_ROUTER}`,
  );
  assert(
    eqAddress(input.sourceFeeRoot, PRODUCTION_BSC_EXISTING_FEE_ROOT),
    `BSC fee root must be ${PRODUCTION_BSC_EXISTING_FEE_ROOT}`,
  );
  const { config, overlays } = overlayProductionPiecewiseEntries(
    input.currentConfig,
    input.usdcRoute,
    input.domainByDestination,
    input.oldRootPointers,
    input.desiredTokenFee,
  );
  assert(
    /^[0-9a-f]{40}$/i.test(input.gitCommit),
    'gitCommit must be a full 40-character commit hash',
  );
  const applyConfig = { bsc: config };

  return {
    applyConfig,
    warpRoute: {
      tokens: [{ ...sourceToken, connections: [] }],
    },
    metadata: input.metadata,
    addresses: input.addresses,
    manifest: {
      version: 1,
      readOnlyBuilder: true,
      writesOnchain: false,
      origin: 'bsc',
      routeId: PRODUCTION_APPLY_ROUTE_ID,
      sourceBlock: input.sourceBlock,
      sourceRouter: sourceToken.addressOrDenom,
      sourceFeeRoot: input.sourceFeeRoot,
      gitCommit: input.gitCommit,
      applyConfigHash: hashProductionApplyConfig(applyConfig),
      fallbackBps: 15,
      overlayCount: 7,
      overlays,
      files: PRODUCTION_APPLY_ARTIFACT_PATHS,
      registryMergeOrder: ['generated-artifact', 'base-registry'],
      requiresBaseRegistry: true,
      artifactScope: {
        metadataChains: ['bsc'],
        addressChains: ['bsc'],
        applyConfigChains: ['bsc'],
        warpRouteChains: ['bsc'],
      },
      strategies: {
        fork: 'config/environments/mainnet3/warp/strategies/moonpay-production-piecewise-fork.yaml',
        forkSubmit:
          'config/environments/mainnet3/warp/strategies/moonpay-production-piecewise-fork-submit.yaml',
        icaFile:
          'config/environments/mainnet3/warp/strategies/moonpay-production-piecewise-ica-file.yaml',
        futureLive:
          'config/environments/mainnet3/warp/strategies/moonpay-production-piecewise-live.yaml',
      },
    },
  };
}

export function emitProductionApplyArtifact(
  outputDirectory: string,
  artifact: ProductionApplyArtifact,
): Record<keyof typeof PRODUCTION_APPLY_ARTIFACT_PATHS, string> {
  const files = Object.fromEntries(
    Object.entries(PRODUCTION_APPLY_ARTIFACT_PATHS).map(([key, relative]) => [
      key,
      path.resolve(outputDirectory, relative),
    ]),
  ) as Record<keyof typeof PRODUCTION_APPLY_ARTIFACT_PATHS, string>;
  writeYaml(files.metadata, artifact.metadata);
  writeYaml(files.addresses, artifact.addresses);
  writeYaml(files.warpRoute, artifact.warpRoute);
  writeYaml(files.applyConfig, artifact.applyConfig);
  writeJson(files.manifest, artifact.manifest);
  return files;
}
