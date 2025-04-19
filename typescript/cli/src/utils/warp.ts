import { WarpCoreConfig } from '@hyperlane-xyz/sdk';

import { readWarpCoreConfig } from '../config/warp.js';
import { CommandContext } from '../context/types.js';
import { logRed } from '../logger.js';

import { selectRegistryWarpRoute } from './tokens.js';

/**
 * Gets a {@link WarpCoreConfig} based on the provided path or prompts the user to choose one:
 * - if `symbol` is provided the user will have to select one of the available warp routes.
 * - if `warp` is provided the config will be read by the provided file path.
 * - if none is provided the CLI will exit.
 */
export async function getWarpCoreConfigOrExit({
  context,
  symbol,
  warp,
}: {
  context: CommandContext;
  symbol?: string;
  warp?: string;
}): Promise<[string, WarpCoreConfig]> {
  let warpCoreConfig: WarpCoreConfig;
  let warpId: string;
  if (symbol) {
    [warpId, warpCoreConfig] = await selectRegistryWarpRoute(
      context.registry,
      symbol,
    );
  } else if (warp) {
    warpCoreConfig = readWarpCoreConfig(warp);
    // TODO make this more resilient
    warpId = warp.split('/').pop()!;

    console.log(warpId);
  } else {
    logRed(`Please specify either a symbol or warp config`);
    process.exit(0);
  }

  return [warpId, warpCoreConfig];
}
