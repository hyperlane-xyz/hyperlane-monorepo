import { defaultMultisigConfigs, getDomainId } from '@hyperlane-xyz/sdk';

import { getArgs } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

async function main() {
  const { environment } = await getArgs().argv;
  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  const payload = config.supportedChainNames.map((chain) => {
    const multisig = defaultMultisigConfigs[chain];
    if (!multisig) {
      throw Error(`No multisig config found for ${chain}`);
    }

    return {
      domain: multiProvider.getDomainId(chain),
      threshold: multisig.threshold,
      validators: multisig.validators,
    };
  });

  console.log(JSON.stringify(payload, null, 2));
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
