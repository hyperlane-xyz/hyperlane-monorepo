import { format } from 'util';

import { objMap, promiseObjAll } from '@hyperlane-xyz/sdk';
import { error } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts';
import { KEY_ROLE_ENUM } from '../../src/agents/roles';
import {
  DeterministicKeyRoles,
  getDeterministicKey,
} from '../../src/funding/deterministic-keys';
import { assertChain } from '../../src/utils/utils';
import { getArgs, getCoreEnvironmentConfig, getEnvironment } from '../utils';

async function main() {
  const argv = await getArgs()
    .string('role')
    .choices(
      'role',
      Object.keys(DeterministicKeyRoles).filter((x) => !(parseInt(x) >= 0)),
    )
    .demandOption('role')
    .number('gas-amount')
    .alias('g', 'gas-amount')
    .describe(
      'gas-amount',
      'The amount of gas this key should have on each chain',
    )
    .demandOption('g')
    .string('chains-to-skip')
    .array('chains-to-skip')
    .describe('chains-to-skip', 'Chains to skip sending from or sending to.')
    .default('chains-to-skip', [])
    .coerce('chains-to-skip', (chainStrs: string[]) =>
      chainStrs.map((chainStr: string) => assertChain(chainStr)),
    ).argv;

  const environment = await getEnvironment();
  const coreConfig = getCoreEnvironmentConfig(environment);
  const multiProvider = await coreConfig.getMultiProvider(
    Contexts.Abacus,
    KEY_ROLE_ENUM.Deployer,
  );

  const key = await getDeterministicKey(
    environment,
    // @ts-ignore
    DeterministicKeyRoles[argv.role],
  );

  await promiseObjAll(
    objMap(multiProvider.chainMap, async (_, dc) => {
      // fund signer on each network with gas * gasPrice
      const actual = await dc.provider.getBalance(key.address);
      const gasPrice = await dc.provider.getGasPrice();
      const desired = gasPrice.mul(argv.gasAmount!);
      const value = desired.sub(actual);
      if (value.gt(0)) {
        await dc.sendTransaction({
          to: key.address,
          value,
        });
      }
    }),
  );
}

main().catch((err) => {
  error('Error occurred in main', {
    // JSON.stringifying an Error returns '{}'.
    // This is a workaround from https://stackoverflow.com/a/60370781
    error: format(err),
  });
  process.exit(1);
});
