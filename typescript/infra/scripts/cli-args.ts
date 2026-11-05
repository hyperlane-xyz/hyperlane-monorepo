import yargs, { type Argv } from 'yargs';

import {
  type DeployEnvironment,
  assertEnvironment,
} from '../src/config/deploy-environment.js';

export function withEnvironment<T>(
  args: Argv<T>,
  opts?: { defaultEnv?: DeployEnvironment },
) {
  const chain = args
    .describe('environment', 'deploy environment')
    .coerce('environment', assertEnvironment)
    .alias('e', 'environment');
  return opts?.defaultEnv
    ? chain.default('environment', opts.defaultEnv)
    : chain.demandOption('environment');
}

export function getArgs() {
  return withEnvironment(yargs(process.argv.slice(2)));
}

export function withWarpRouteId<T>(args: Argv<T>) {
  return args.describe('warpRouteId', 'warp route id').string('warpRouteId');
}

export function withRegistryCommit<T>(args: Argv<T>) {
  return args
    .describe(
      'registryCommit',
      'Registry version (commit, branch, or tag). If not provided, will prompt interactively.',
    )
    .string('registryCommit');
}

export function withMetrics<T>(args: Argv<T>) {
  return args
    .describe('metrics', 'metrics')
    .boolean('metrics')
    .default('metrics', true);
}

export function withYes<T>(args: Argv<T>) {
  return args
    .describe('yes', 'Skip confirmations and use defaults')
    .boolean('yes')
    .alias('y', 'yes')
    .default('yes', false);
}
