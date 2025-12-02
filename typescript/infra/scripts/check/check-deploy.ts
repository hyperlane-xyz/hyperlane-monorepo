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
    warpRouteId,
    registry,
  } = await getCheckDeployArgs().argv;

  const governor = await getGovernor(
    module,
    context,
    environment,
    asDeployer,
    warpRouteId,
    chains,
    fork,
    govern,
    undefined,
    registry,
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
