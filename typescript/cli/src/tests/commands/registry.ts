import { $ } from 'zx';

import { CHAIN_NAME, REGISTRY_PATH } from './zx-helpers.js';

export async function hyperlaneWarpRead(
  warpAddress: string,
  warpDeployOutputPath: string,
) {
  return $`yarn workspace @hyperlane-xyz/cli run hyperlane warp read \
        --registry ${REGISTRY_PATH} \
        --overrides " " \
        --address ${warpAddress} \
        --chain ${CHAIN_NAME} \
        --config ${warpDeployOutputPath}`;
}
