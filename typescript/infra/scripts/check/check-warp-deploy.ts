import chalk from 'chalk';

import { WarpRouteIds } from '../../config/warp.js';
import { Modules } from '../agent-utils.js';

import { check, getCheckArgs } from './check-utils.js';

async function checkWarp() {
  const argv = await getCheckArgs().argv;

  // TODO: consider retrying this if check throws an error
  for (const warpRouteId of Object.values(WarpRouteIds)) {
    console.log(`\nChecking warp route ${warpRouteId}...`);
    try {
      await check({
        ...argv,
        warpRouteId,
        module: Modules.WARP,
      });
    } catch (e) {
      console.log(chalk.red(`Error checking warp route ${warpRouteId}: ${e}`));
    }
  }
}

checkWarp()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
