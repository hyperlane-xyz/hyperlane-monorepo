import { stringify as yamlStringify } from 'yaml';
import { type CommandModule } from 'yargs';

import { runWarpAltCheck } from '../check/warp-alt.js';
import { type CommandModuleWithContext } from '../context/types.js';
import { log, logCommandHeader, logGreen } from '../logger.js';
import { runWarpAltRead } from '../read/warp-alt.js';
import { indentYamlOrJson } from '../utils/files.js';

import { chainCommandOption, warpRouteIdCommandOption } from './options.js';

const read: CommandModuleWithContext<{
  warpRouteId: string;
  chain?: string;
}> = {
  command: 'read',
  describe: 'Read on-chain SVM Address Lookup Table contents for a warp route',
  builder: {
    'warp-route-id': { ...warpRouteIdCommandOption, demandOption: true },
    chain: { ...chainCommandOption, demandOption: false },
  },
  handler: async ({ context, warpRouteId, chain }) => {
    logCommandHeader('Hyperlane Warp ALT Reader');

    const result = await runWarpAltRead({ context, warpRouteId, chain });

    logGreen(`✅ Warp route ALTs read successfully:\n`);
    log(indentYamlOrJson(yamlStringify(result, null, 2), 4));
    process.exit(0);
  },
};

const check: CommandModuleWithContext<{
  warpRouteId: string;
  chain?: string;
}> = {
  command: 'check',
  describe:
    'Verify that on-chain SVM Address Lookup Tables match the expected contents for a warp route',
  builder: {
    'warp-route-id': { ...warpRouteIdCommandOption, demandOption: true },
    chain: { ...chainCommandOption, demandOption: false },
  },
  handler: async ({ context, warpRouteId, chain }) => {
    logCommandHeader('Hyperlane Warp ALT Check');
    await runWarpAltCheck({ context, warpRouteId, chain });
    process.exit(0);
  },
};

export const altCommand: CommandModule = {
  command: 'alt',
  describe: 'Manage SVM Address Lookup Tables for a warp route',
  builder: (yargs) =>
    yargs.command(check).command(read).version(false).demandCommand(),
  handler: () => log('Command required'),
};
