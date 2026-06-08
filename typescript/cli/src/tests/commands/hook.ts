import { $, type ProcessPromise } from 'zx';

import { localTestRunCmdPrefix } from './helpers.js';

$.verbose = true;

export function hyperlaneHookDeploy({
  chain,
  configPath,
  keyFlags,
  registryPath,
  outPath,
}: {
  chain: string;
  configPath: string;
  keyFlags: string[];
  registryPath: string;
  outPath?: string;
}): ProcessPromise {
  const cmdPrefix = localTestRunCmdPrefix();
  const flags = [
    '--chain',
    chain,
    '--config',
    configPath,
    ...keyFlags,
    '--registry',
    registryPath,
    '--verbosity',
    'debug',
    '--yes',
  ];

  if (outPath) {
    flags.push('--out', outPath);
  }

  return $`${cmdPrefix} hyperlane hook deploy ${flags}`;
}
