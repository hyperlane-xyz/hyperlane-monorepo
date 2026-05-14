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
import { logGray } from '../logger.js';
import { getWarpCoreConfigOrExit } from '../utils/warp.js';

export async function runWarpAltRead({
  context,
  warpRouteId,
  chain,
}: {
  context: CommandContext;
  warpRouteId: string;
  chain?: ChainName;
}) {
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

  if (chain) {
    assert(filtered[chain], `No ALT addresses registered for chain "${chain}"`);
  }

  return promiseObjAll(
    objMap(filtered, async (chainName, addresses) => {
      const chainMetadata = chainLookup.getChainMetadata(chainName);
      const reader = createWarpAltReader(chainMetadata);
      return reader.read(addresses);
    }),
  );
}
