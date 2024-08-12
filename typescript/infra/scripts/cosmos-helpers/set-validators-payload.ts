import { defaultMultisigConfigs, getDomainId } from '@hyperlane-xyz/sdk';
import { strip0x } from '@hyperlane-xyz/utils';

import { getArgs } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

async function main() {
  const { environment } = await getArgs().argv;
  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  const payloads = config.supportedChainNames.map((chain) => {
    const multisig = defaultMultisigConfigs[chain];
    if (!multisig) {
      throw Error(`No multisig config found for ${chain}`);
    }

    return {
      set_validators: {
        domain: multiProvider.getDomainId(chain),
        threshold: multisig.threshold,
        validators: multisig.validators.map(strip0x),
      },
    };
  });

  const keyName = 'low_balance_test';

  for (const payload of payloads) {
    const cmd = `neutrond tx wasm execute neutron1pa0fupajl0ysmdylcwau5szdkdcxg7rxt967p04felf9n6hc7zvqh4ycv9 '{ "set_validators": ${JSON.stringify(
      payload,
    )} }' --from ${keyName} --chain-id neutron-1 --node https://rpc-magnetix.neutron-1.neutron.org:443 --fees 50000ntrn`;

    console.log(cmd);

    return;
  }
  // console.log(JSON.stringify(payload, null, 2));
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
