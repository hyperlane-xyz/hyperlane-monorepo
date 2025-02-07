import { stringify as yamlStringify } from 'yaml';

import { defaultMultisigConfigs } from '@hyperlane-xyz/sdk';
import { strip0x } from '@hyperlane-xyz/utils';

import { getArgs } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

/**
 * Generates a yaml payload intended to be consumed as a config by the cw-hyperlane
 * deploy CLI. Expected output is of the form:
 * ```
 * deploy:
 *   ism:
 *     type: multisig
 *     validators:
 *       "1":
 *         addrs:
 *           - 03c842db86a6a3e524d4a6615390c1ea8e2b9541
 *           - 94438a7de38d4548ae54df5c6010c4ebc5239eae
 *           - 5450447aee7b544c462c9352bef7cad049b0c2dc
 *           - 38c7a4ca1273ead2e867d096adbcdd0e2acb21d8
 *           - b3ac35d3988bca8c2ffd195b1c6bee18536b317b
 *           - b683b742b378632a5f73a2a5a45801b3489bba44
 *           - bf1023eff3dba21263bf2db2add67a0d6bcda2de
 *        threshold: 4
 * ```
 *
 * Which can be copied into a config YAML file and passed to the deploy CLI.
 * Some additional context can be found here:
 * https://www.notion.so/hyperlanexyz/Updating-Neutron-default-ISM-091a3528343c4e7b98453768eb950b38
 */

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
          // Must strip 0x from addresses for compatibility with cosmos tooling
          addrs: multisig.validators.map(({ address }) => strip0x(address)),
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
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
