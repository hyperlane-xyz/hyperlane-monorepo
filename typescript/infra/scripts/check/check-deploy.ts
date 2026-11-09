import { assert, objMap } from '@hyperlane-xyz/utils';
import { writeJson } from '@hyperlane-xyz/utils/fs';

import {
  getCheckDeployArgs,
  getGovernor,
  logViolations,
} from './check-utils.js';

async function main() {
  const {
    module,
    context,
    environment,
    asDeployer,
    chains,
    fork,
    govern,
    icaRouterVersion,
    transactionsFile,
  } = await getCheckDeployArgs().argv;
  assert(module, 'Module is required');

  const governor = await getGovernor(
    module,
    context,
    environment,
    asDeployer,
    chains,
    fork,
    govern,
    undefined,
    icaRouterVersion,
  );

  if (fork) {
    await governor.checkChain(fork);
    if (govern) {
      await governor.govern(false, fork);
    }
  } else {
    await governor.check(chains);
    if (govern) {
      await governor.govern();
    }
  }

  if (transactionsFile) {
    const calls = await governor.prepareGovernanceCalls();
    writeJson(
      transactionsFile,
      objMap(calls, (_, chainCalls) =>
        chainCalls.map((call) => ({
          ...call,
          value: call.value?.toString() ?? '0',
        })),
      ),
    );
    console.info(`Prepared governance calls written to ${transactionsFile}`);
  }

  if (!govern && !transactionsFile) {
    const violations = governor.getCheckerViolations();
    if (violations.length > 0) {
      logViolations(violations);

      if (!fork) {
        throw new Error(
          `Checking ${module} deploy yielded ${violations.length} violations`,
        );
      }
    } else {
      console.info(`${module} checker found no violations`);
    }
  }

  process.exit(0);
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
