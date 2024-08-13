import { stringify as yamlStringify } from 'yaml';

import { defaultMultisigConfigs } from '@hyperlane-xyz/sdk';
import { strip0x } from '@hyperlane-xyz/utils';

import { getArgs } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

async function main() {
  const { environment } = await getArgs().argv;
  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  const validatorConfigs = Object.fromEntries(
    config.supportedChainNames.map((chain) => {
      const multisig = defaultMultisigConfigs[chain];
      if (!multisig) {
        throw Error(`No multisig config found for ${chain}`);
      }

      return [
        multiProvider.getDomainId(chain),
        {
          addrs: multisig.validators.map(strip0x),
          threshold: multisig.threshold,
        },
      ];
    }),
  );

  const deployConfig = {
    deploy: {
      ism: {
        type: 'multisig',
        validators: validatorConfigs,
      },
    },
  };

  console.log(yamlStringify(deployConfig));

  // const keyName = 'low_balance_test';

  // for (const payload of payloads) {
  //   const cmd = `neutrond tx wasm execute neutron1pa0fupajl0ysmdylcwau5szdkdcxg7rxt967p04felf9n6hc7zvqh4ycv9 '${JSON.stringify(
  //     payload,
  //   )}' --from ${keyName} --chain-id neutron-1 --node https://rpc-magnetix.neutron-1.neutron.org:443 --fees 50000untrn`;

  //   console.log(cmd);

  //   return;
  // }
  // // console.log(JSON.stringify(payload, null, 2));
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
