import { $ } from 'zx';

import { ANVIL_KEY, REGISTRY_PATH } from './helpers.js';

/**
 * Deploys the Hyperlane core contracts to the specified chain using the provided config.
 */
export async function hyperlaneCoreDeploy(
  chain: string,
  coreInputPath: string,
) {
  return $`yarn workspace @hyperlane-xyz/cli run hyperlane core deploy \
        --registry ${REGISTRY_PATH} \
        --overrides " " \
        --config ${coreInputPath} \
        --chain ${chain} \
        --key ${ANVIL_KEY} \
        --verbosity debug \
        --yes`;
}
