import { $, type ProcessPromise } from 'zx';

import { localTestRunCmdPrefix } from './helpers.js';

export function hyperlaneForkRaw({
  registry,
  forkConfigPath,
  port,
}: {
  registry: string;
  forkConfigPath: string;
  port: number;
}): ProcessPromise {
  return $`${localTestRunCmdPrefix()} hyperlane fork \
        --registry ${registry} \
        --fork-config ${forkConfigPath} \
        --port ${port} \
        --verbosity debug`;
}
