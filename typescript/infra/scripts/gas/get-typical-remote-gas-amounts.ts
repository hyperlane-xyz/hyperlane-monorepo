import { ChainMap } from '@hyperlane-xyz/sdk';
import { stringifyObject } from '@hyperlane-xyz/utils';

import { getOverheadWithOverrides } from '../../config/environments/mainnet3/igp.js';
import { getChain } from '../../config/registry.js';
import { getTypicalRemoteGasAmount } from '../../src/config/gas-oracle.js';
import { getArgs } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

// This script exists to print the typical local -> remote gas amounts for a given environment.
// This is useful for Jake to use in his own models for assessing message costs.

async function main() {
  const args = await getArgs().argv;

  if (args.environment !== 'mainnet3') {
    throw new Error('This script only supports the mainnet3 environment');
  }

  const environmentConfig = getEnvironmentConfig(args.environment);

  // Local -> Remote -> Amount of gas.
  // Local is important because depending on the validator threshold, the cost
  // to verify changes. Remote is important because the cost to execute the
  // message can change depending on the chain (e.g. alt VMs, or some exceptions like Moonbeam
  // that has non-standard EVM gas usage).
  const amounts: ChainMap<ChainMap<number>> = {};

  for (const local of environmentConfig.supportedChainNames) {
    for (const remote of environmentConfig.supportedChainNames) {
      if (local === remote) {
        continue;
      }
      amounts[local] = amounts[local] || {};
      amounts[local][remote] = getTypicalRemoteGasAmount(
        local,
        remote,
        getChain(remote).protocol,
        getOverheadWithOverrides,
      );
    }
  }

  console.log(stringifyObject(amounts, 'json', 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
