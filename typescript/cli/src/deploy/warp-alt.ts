import { stringify as yamlStringify } from 'yaml';

import { createWarpTokenReader } from '@hyperlane-xyz/deploy-sdk';
import {
  SealevelSigner,
  createWarpAltManager,
} from '@hyperlane-xyz/sealevel-sdk';
import { type ChainName, altVmChainLookup } from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  assert,
  mustGet,
  objFilter,
  objMap,
  promiseObjAll,
} from '@hyperlane-xyz/utils';

import { type WriteCommandContext } from '../context/types.js';
import { log, logGray, logGreen } from '../logger.js';
import { indentYamlOrJson } from '../utils/files.js';
import { getWarpCoreConfigOrExit } from '../utils/warp.js';

export async function runWarpAltCreate({
  context,
  warpRouteId,
  chain,
  force,
}: {
  context: WriteCommandContext;
  warpRouteId: string;
  chain?: ChainName;
  force: boolean;
}): Promise<void> {
  const warpCoreConfig = await getWarpCoreConfigOrExit({
    context,
    warpRouteId,
  });

  const chainLookup = altVmChainLookup(context.multiProvider);

  const existingAlts = warpCoreConfig.options?.svmAltAddresses ?? {};
  const svmTokens = objFilter(
    Object.fromEntries(
      warpCoreConfig.tokens.map((t) => [t.chainName, t] as const),
    ),
    (chainName, token): token is (typeof warpCoreConfig.tokens)[number] => {
      if (chain && chainName !== chain) return false;
      if (
        context.multiProvider.getProtocol(chainName) !== ProtocolType.Sealevel
      ) {
        logGray(`Skipping ${chainName} — not an SVM chain`);
        return false;
      }
      if (existingAlts[chainName] && !force) {
        logGray(
          `Skipping ${chainName} — ALTs already registered. Re-run with --force to recreate (existing frozen ALTs cannot be reclaimed).`,
        );
        return false;
      }
      return true;
    },
  );

  assert(
    Object.keys(svmTokens).length > 0,
    'No SVM chains require ALT creation',
  );

  const altAddressesByChain = await promiseObjAll(
    objMap(svmTokens, async (chainName, token) => {
      assert(
        token.addressOrDenom,
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

      const manager = createWarpAltManager(chainMetadata, signer);
      const writer = manager.createWriter(deployed.config.type);
      const { core, warpSpecific } = await writer.create(deployed);

      logGreen(
        `✅ Created ALTs for ${chainName}: core=${core}, warpSpecific=[${warpSpecific.join(', ')}]`,
      );
      return { core, warpSpecific };
    }),
  );

  warpCoreConfig.options ??= {};
  warpCoreConfig.options.svmAltAddresses = {
    ...warpCoreConfig.options.svmAltAddresses,
    ...altAddressesByChain,
  };

  await context.registry.addWarpRoute(warpCoreConfig);

  logGreen('✅ Registry updated with new ALT addresses:');
  log(indentYamlOrJson(yamlStringify(warpCoreConfig, null, 2), 4));
}
