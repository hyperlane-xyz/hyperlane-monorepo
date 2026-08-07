#!/usr/bin/env tsx

import { execFileSync } from 'node:child_process';

import {
  CrossCollateralRoutingFee__factory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
import {
  EvmWarpModule,
  type HypTokenRouterConfig,
  MultiProvider,
  TokenType,
  extractIsmAndHookFactoryAddresses,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32, assert } from '@hyperlane-xyz/utils';
import yargs from 'yargs';

import { awIcas } from '../../config/environments/mainnet3/governance/ica/aw.js';
import { BSC_PIECEWISE_USDC_DESTINATIONS } from '../../config/environments/mainnet3/warp/configGetters/getUSDTCitreaMoonpayWarpConfig.js';
import { WarpRouteIds } from '../../config/environments/mainnet3/warp/warpIds.js';
import {
  getChainAddresses,
  getChainMetadata,
  getRegistry,
} from '../../config/registry.js';
import { tokens } from '../../src/config/warp.js';

import {
  PRODUCTION_APPLY_ROUTE_ID,
  PRODUCTION_BSC_USDT_ROUTER,
  buildProductionApplyArtifact,
  emitProductionApplyArtifact,
} from './build-production-piecewise-apply-config-lib.js';

const DEFAULT_OUTPUT = '/tmp/moonpay-production-piecewise-apply';

async function main(): Promise<void> {
  const { output } = await yargs(process.argv.slice(2))
    .strict()
    .option('output', {
      alias: 'o',
      type: 'string',
      default: DEFAULT_OUTPUT,
      describe: 'Local directory for the BSC-only registry and manifest',
    })
    .parseAsync();

  const registry = getRegistry();
  const sourceRoute = registry.getWarpRoute(WarpRouteIds.USDTCitreaMoonpay);
  const usdcRoute = registry.getWarpRoute(WarpRouteIds.USDCCitreaMoonpay);
  assert(sourceRoute, 'USDT/moonpay route is missing from the registry');
  assert(usdcRoute, 'USDC/moonpay route is missing from the registry');
  const metadata = getChainMetadata();
  const addresses = getChainAddresses();
  assert(metadata.bsc, 'BSC metadata is missing from the registry');
  assert(addresses.bsc?.mailbox, 'BSC addresses are missing from the registry');

  // This MultiProvider has no signer. The builder calls read() only and never
  // invokes update(), createTokenFeeUpdateTxs(), or a transaction submitter.
  const multiProvider = new MultiProvider(metadata);
  const module = new EvmWarpModule(multiProvider, {
    chain: 'bsc',
    config: {
      type: TokenType.crossCollateral,
      token: tokens.bsc.USDT,
      mailbox: addresses.bsc.mailbox,
      owner: awIcas.bsc,
      scale: { numerator: 1, denominator: 1_000_000_000_000 },
    } satisfies HypTokenRouterConfig,
    addresses: {
      deployedTokenRoute: PRODUCTION_BSC_USDT_ROUTER,
      ...extractIsmAndHookFactoryAddresses(addresses.bsc),
    },
  });
  const provider = multiProvider.getProvider('bsc');
  const [currentConfig, sourceBlock, sourceFeeRoot] = await Promise.all([
    module.read(),
    provider.getBlockNumber(),
    TokenRouter__factory.connect(
      PRODUCTION_BSC_USDT_ROUTER,
      provider,
    ).feeRecipient(),
  ]);
  const feeRoot = CrossCollateralRoutingFee__factory.connect(
    sourceFeeRoot,
    provider,
  );
  const domainByDestination = Object.fromEntries(
    BSC_PIECEWISE_USDC_DESTINATIONS.map((destination) => [
      destination,
      multiProvider.getDomainId(destination),
    ]),
  );
  const oldRootPointers = await Promise.all(
    BSC_PIECEWISE_USDC_DESTINATIONS.map(async (destination) => {
      const target = usdcRoute.tokens.find(
        ({ chainName }) => chainName === destination,
      );
      assert(
        target?.addressOrDenom,
        `Missing USDC/moonpay target for ${destination}`,
      );
      const targetRouterKey = addressToBytes32(target.addressOrDenom);
      return {
        destination,
        domain: domainByDestination[destination],
        targetRouter: target.addressOrDenom,
        targetRouterKey,
        oldLeaf: await feeRoot.feeContracts(
          domainByDestination[destination],
          targetRouterKey,
        ),
      };
    }),
  );
  const gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();

  const artifact = buildProductionApplyArtifact({
    currentConfig,
    sourceRoute,
    usdcRoute,
    metadata: metadata.bsc,
    addresses: addresses.bsc,
    sourceBlock,
    sourceFeeRoot,
    gitCommit,
    domainByDestination,
    oldRootPointers,
  });
  const files = emitProductionApplyArtifact(output, artifact);
  console.log(
    JSON.stringify(
      {
        mode: 'read-only',
        writesOnchain: false,
        routeId: PRODUCTION_APPLY_ROUTE_ID,
        sourceBlock,
        gitCommit,
        applyConfigHash: artifact.manifest.applyConfigHash,
        overlayCount: artifact.manifest.overlayCount,
        files,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
