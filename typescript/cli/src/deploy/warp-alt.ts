import { stringify as yamlStringify } from 'yaml';

import { createWarpTokenReader } from '@hyperlane-xyz/deploy-sdk';
import {
  SealevelSigner,
  createWarpAltManager,
} from '@hyperlane-xyz/sealevel-sdk';
import { type ChainName, altVmChainLookup } from '@hyperlane-xyz/sdk';
import { ProtocolType, assert, mustGet } from '@hyperlane-xyz/utils';

import { type WriteCommandContext } from '../context/types.js';
import { log, logGray, logGreen, logRed } from '../logger.js';
import { indentYamlOrJson } from '../utils/files.js';
import { findWarpTokenForChain, resolveWarpRouteId } from '../utils/warp.js';

export async function runWarpAltCreate({
  context,
  warpRouteId,
  chain,
  force,
  fullForce,
}: {
  context: WriteCommandContext;
  warpRouteId: string;
  chain?: ChainName;
  force: boolean;
  fullForce: boolean;
}): Promise<void> {
  // Resolve the id up front: `--warp-route-id` accepts symbol shorthand, and
  // the frozen ALTs must be persisted under the same id every later `read` /
  // `check` resolves to (the on-chain ALTs are irreversible once frozen).
  const resolvedWarpRouteId = await resolveWarpRouteId({
    context,
    warpRouteId,
  });
  const warpCoreConfig =
    await context.registry.getWarpRoute(resolvedWarpRouteId);
  assert(
    warpCoreConfig,
    `No warp route found with ID "${resolvedWarpRouteId}"`,
  );

  const chainLookup = altVmChainLookup(context.multiProvider);

  // --full-force implies --force (it's a strict superset).
  const effectiveForce = force || fullForce;

  const existingAlts = warpCoreConfig.options?.sealevel?.altAddresses ?? {};

  const routeChains = new Set(warpCoreConfig.tokens.map((t) => t.chainName));
  assert(
    !chain || routeChains.has(chain),
    `Chain "${chain}" is not part of warp route "${resolvedWarpRouteId}"`,
  );

  const svmChains = [...routeChains].filter((chainName) => {
    if (chain && chainName !== chain) return false;
    if (
      context.multiProvider.getProtocol(chainName) !== ProtocolType.Sealevel
    ) {
      logGray(`Skipping ${chainName} — not an SVM chain`);
      return false;
    }
    if (existingAlts[chainName] && !effectiveForce) {
      logGray(
        `Skipping ${chainName} — ALTs already registered. Re-run with --force to recreate only the warp-specific ALTs (reusing the core ALT) or --full-force to recreate everything (existing frozen ALTs cannot be reclaimed).`,
      );
      return false;
    }
    return true;
  });

  // Skipping every chain (e.g. re-running a fully-registered route without
  // flags) is an intentional no-op, not a failure.
  if (svmChains.length === 0) {
    logGreen('✅ Nothing to do — no SVM chains require ALT creation');
    return;
  }

  const settled = await Promise.allSettled(
    svmChains.map(async (chainName) => {
      const token = findWarpTokenForChain(warpCoreConfig, chainName);
      assert(
        token?.addressOrDenom,
        `No warp token address found for chain "${chainName}"`,
      );

      const signer = mustGet(context.altVmSigners, chainName);
      assert(
        signer instanceof SealevelSigner,
        `Expected a Sealevel signer for chain "${chainName}"`,
      );

      const chainMetadata = chainLookup.getChainMetadata(chainName);
      const warpReader = createWarpTokenReader(chainMetadata, chainLookup);
      const deployed = await warpReader.read(token.addressOrDenom);

      // --force without --full-force reuses the recorded core ALT;
      // --full-force regenerates everything by leaving it undefined.
      const existingCoreAlt =
        force && !fullForce ? existingAlts[chainName]?.core : undefined;

      const manager = createWarpAltManager(chainMetadata, signer);
      const writer = manager.createWriter(deployed.config.type, {
        existingCoreAlt,
      });
      const { core, warpSpecific } = await writer.create(deployed);

      logGreen(
        `✅ Created ALTs for ${chainName}: core=${core}, warpSpecific=[${warpSpecific.join(', ')}]`,
      );
      return { core, warpSpecific };
    }),
  );

  // Freezing an ALT is irreversible, so persist every chain that succeeded even
  // when a sibling chain fails; otherwise the frozen ALTs are orphaned (rent
  // burned) and re-created on the next run.
  const newAltAddresses: Record<
    ChainName,
    { core: string; warpSpecific: string[] }
  > = {};
  const failedChains: ChainName[] = [];
  settled.forEach((result, i) => {
    const chainName = svmChains[i];
    if (result.status === 'fulfilled') {
      newAltAddresses[chainName] = result.value;
    } else {
      failedChains.push(chainName);
      logRed(
        `❌ Failed to create ALTs for ${chainName}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
      );
    }
  });

  if (Object.keys(newAltAddresses).length > 0) {
    warpCoreConfig.options ??= {};
    warpCoreConfig.options.sealevel ??= {};
    warpCoreConfig.options.sealevel.altAddresses = {
      ...warpCoreConfig.options.sealevel.altAddresses,
      ...newAltAddresses,
    };

    await context.registry.addWarpRoute(warpCoreConfig, {
      warpRouteId: resolvedWarpRouteId,
    });

    logGreen('✅ Registry updated with new ALT addresses:');
    log(indentYamlOrJson(yamlStringify(warpCoreConfig, null, 2), 4));
  }

  assert(
    failedChains.length === 0,
    `ALT creation failed for chain(s): ${failedChains.join(', ')}`,
  );
}
