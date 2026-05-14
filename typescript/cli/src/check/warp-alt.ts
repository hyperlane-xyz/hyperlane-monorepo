import { stringify as yamlStringify } from 'yaml';

import { createWarpTokenReader } from '@hyperlane-xyz/deploy-sdk';
import { createWarpAltReader } from '@hyperlane-xyz/sealevel-sdk';
import { type ChainName, altVmChainLookup } from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  assert,
  objFilter,
  objMap,
  promiseObjAll,
} from '@hyperlane-xyz/utils';

import { type CommandContext } from '../context/types.js';
import { log, logGray, logGreen, logRed } from '../logger.js';
import { getWarpCoreConfigOrExit } from '../utils/warp.js';
import { formatYamlViolationsOutput } from '../utils/output.js';

export async function runWarpAltCheck({
  context,
  warpRouteId,
  chain,
}: {
  context: CommandContext;
  warpRouteId: string;
  chain?: ChainName;
}): Promise<void> {
  const warpCoreConfig = await getWarpCoreConfigOrExit({
    context,
    warpRouteId,
  });

  const altAddresses = warpCoreConfig.options?.svmAltAddresses ?? {};
  const chainLookup = altVmChainLookup(context.multiProvider);

  const filtered = objFilter(altAddresses, (chainName, _v): _v is typeof _v => {
    if (chain && chainName !== chain) return false;
    if (
      context.multiProvider.getProtocol(chainName) !== ProtocolType.Sealevel
    ) {
      logGray(`Skipping ${chainName} — not an SVM chain`);
      return false;
    }
    return true;
  });

  assert(
    Object.keys(filtered).length > 0,
    chain
      ? `No ALT addresses registered for chain "${chain}"`
      : 'No SVM chains have ALT addresses registered for this warp route',
  );

  const diffs = await promiseObjAll(
    objMap(filtered, async (chainName, addresses) => {
      const token = warpCoreConfig.tokens.find(
        (t) => t.chainName === chainName,
      );
      assert(
        token?.addressOrDenom,
        `No warp token entry found for chain "${chainName}"`,
      );

      const chainMetadata = chainLookup.getChainMetadata(chainName);
      const warpReader = createWarpTokenReader(chainMetadata, chainLookup);
      const deployed = await warpReader.read(token.addressOrDenom);

      const altReader = createWarpAltReader(chainMetadata);
      const typedReader = altReader.createReader(deployed.config.type);
      return typedReader.check(addresses, deployed);
    }),
  );

  const hasDiff = Object.values(diffs).some(
    (d) =>
      d.core.missingFromAlt.length > 0 ||
      d.core.extraInAlt.length > 0 ||
      d.core.frozenMismatch ||
      d.warpSpecific.missingFromAlt.length > 0 ||
      d.warpSpecific.extraInAlt.length > 0 ||
      d.warpSpecific.frozenMismatch,
  );

  if (hasDiff) {
    log(formatYamlViolationsOutput(yamlStringify(diffs, null, 2)));
    logRed('❌ Warp route ALT check failed: diffs detected');
    process.exit(1);
  }

  logGreen('✅ Warp route ALTs match the expected on-chain state');
}
