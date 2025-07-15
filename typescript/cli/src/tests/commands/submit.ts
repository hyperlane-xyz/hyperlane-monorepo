import { $ } from 'zx';

import { localTestRunCmdPrefix } from './helpers.js';

export async function hyperlaneSubmit({
  transactions,
  registry,
  privateKey,
  hypKey,
}: {
  transactions: string;
  registry: string;
  privateKey?: string;
  hypKey?: string;
}) {
  return $`${
    hypKey ? ['HYP_KEY=' + hypKey] : []
  } ${localTestRunCmdPrefix()} hyperlane submit \
        --registry ${registry} \
        --transactions ${transactions} \
        ${privateKey ? ['--key', privateKey] : []} \
        --verbosity debug \
        --yes`;
}
