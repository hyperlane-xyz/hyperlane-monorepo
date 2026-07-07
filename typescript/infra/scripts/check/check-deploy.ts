import { assert } from '@hyperlane-xyz/utils';

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
    file,
    registry,
  } = await getCheckDeployArgs().argv;
  if (registry?.length) {
    process.env.REGISTRY_URIS = (
      Array.isArray(registry) ? registry : [registry]
    ).join(',');
  }
  assert(module, 'Module is required');

  const governor = await getGovernor(
    module,
    context,
    environment,
    asDeployer,
    chains,
    fork,
    govern,
  );

  if (fork) {
    await governor.checkChain(fork);
    if (govern) {
      await governor.govern(false, fork, file);
    }
  } else {
    await governor.check(chains);
    if (govern) {
      await governor.govern(true, undefined, file);
    }
  }

  if (!govern) {
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
