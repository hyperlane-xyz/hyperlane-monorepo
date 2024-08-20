import { Modules } from '../agent-utils.js';

import { check, getCheckDeployArgs } from './check-utils.js';

const WARP_ROUTE_IDS = [
  'ECLIP/arbitrum-neutron',
  'ETH/ethereum-viction',
  'EZETH/arbitrum-base-blast-bsc-ethereum-fraxtal-linea-mode-optimism-zircuit',
  'INJ/inevm-injective',
  'TIA/arbitrum-neutron',
  'TIA/mantapacific-neutron',
  'USDC/ancient8-ethereum',
  'USDC/ethereum-inevm',
  'USDC/ethereum-viction',
  'USDT/ethereum-inevm',
  'USDT/ethereum-viction',
];

async function checkWarp() {
  const argv = await getCheckDeployArgs().argv;

  for (const warpRouteId of WARP_ROUTE_IDS) {
    console.log(`Checking warp route ${warpRouteId}`);
    try {
      await check({
        ...argv,
        warpRouteId,
        module: Modules.WARP,
      });
    } catch (e) {
      console.error(e);
    }
  }
}

checkWarp()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
