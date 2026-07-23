import { pathToFileURL } from 'url';

import { assert, rootLogger } from '@hyperlane-xyz/utils';

import { DeployEnvironment } from '../../src/config/deploy-environment.js';
import { getArgs as getBaseArgs, withPushMetrics } from '../agent-utils.js';
import { runFastpathIsmChecks } from '../validators/fastpath/check-fastpath-isms.js';

import { runWarpDeployChecks } from './check-warp-deploy.js';

enum MonorepoCheckName {
  Fastpath = 'fastpath',
  Warp = 'warp',
}

const DEFAULT_MONOREPO_CHECKS = [
  MonorepoCheckName.Warp,
  MonorepoCheckName.Fastpath,
];

interface MonorepoCheckRunnerOptions {
  environment: DeployEnvironment;
  pushMetrics: boolean;
}

interface MonorepoCheckRunnerResult {
  failedCount: number;
  violationsCount: number;
}

type MonorepoCheckRunner = (
  options: MonorepoCheckRunnerOptions,
) => Promise<MonorepoCheckRunnerResult>;

const MONOREPO_CHECK_RUNNERS: Record<MonorepoCheckName, MonorepoCheckRunner> = {
  [MonorepoCheckName.Warp]: async ({ environment, pushMetrics }) => {
    const result = await runWarpDeployChecks({ environment, pushMetrics });
    return {
      failedCount: result.failedWarpRouteChecks.length,
      violationsCount: result.violationsCount,
    };
  },
  [MonorepoCheckName.Fastpath]: async ({ environment, pushMetrics }) => {
    const result = await runFastpathIsmChecks({ environment, pushMetrics });
    return {
      failedCount: result.erroredCount,
      violationsCount: result.violationsCount,
    };
  },
};

function getMonorepoCheckArgs() {
  return withPushMetrics(getBaseArgs())
    .describe('checks', 'Monorepo checks to run')
    .array('checks')
    .choices('checks', Object.values(MonorepoCheckName))
    .default('checks', DEFAULT_MONOREPO_CHECKS);
}

function isMonorepoCheckName(value: string): value is MonorepoCheckName {
  return Object.values<string>(MonorepoCheckName).includes(value);
}

function parseChecks(checks: unknown): MonorepoCheckName[] {
  if (checks === undefined) {
    return DEFAULT_MONOREPO_CHECKS;
  }

  const values = Array.isArray(checks) ? checks : [checks];
  const parsedChecks: MonorepoCheckName[] = [];
  for (const check of values) {
    assert(typeof check === 'string', `Invalid monorepo check ${check}`);
    assert(isMonorepoCheckName(check), `Unsupported monorepo check ${check}`);
    parsedChecks.push(check);
  }
  assert(parsedChecks.length > 0, 'At least one monorepo check is required');
  return parsedChecks;
}

async function main() {
  const { checks, environment, pushMetrics } =
    await getMonorepoCheckArgs().argv;
  const enabledChecks = parseChecks(checks);
  let erroredChecks = 0;
  let failedChecks = 0;
  let violations = 0;

  for (const checkName of enabledChecks) {
    rootLogger.info({ checkName }, 'Running monorepo check');
    try {
      const result = await MONOREPO_CHECK_RUNNERS[checkName]({
        environment,
        pushMetrics,
      });
      failedChecks += result.failedCount;
      violations += result.violationsCount;
      rootLogger.info(
        {
          checkName,
          failedCount: result.failedCount,
          violationsCount: result.violationsCount,
        },
        'Monorepo check completed',
      );
    } catch (error) {
      erroredChecks += 1;
      rootLogger.error({ checkName, error }, 'Monorepo check errored');
    }
  }

  rootLogger.info(
    {
      checks: enabledChecks,
      erroredChecks,
      failedChecks,
      violations,
    },
    'Monorepo checks completed',
  );

  if (erroredChecks > 0 || failedChecks > 0 || violations > 0) {
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    rootLogger.error(error);
    process.exit(1);
  });
}
