import { $, type ProcessPromise } from 'zx';

import { type ChainName } from '@hyperlane-xyz/sdk';
import { type Address } from '@hyperlane-xyz/utils';

import { ANVIL_KEY, REGISTRY_PATH } from '../consts.js';

import { localTestRunCmdPrefix } from './helpers.js';

$.verbose = true;

/**
 * Deploys ICAs on destination chains for a specified owner on the origin chain.
 */
export function hyperlaneIcaDeployRaw({
  origin,
  chains,
  owner,
  privateKey,
  hypKey,
  skipConfirmationPrompts,
}: {
  origin?: ChainName;
  chains?: ChainName[];
  owner?: Address;
  privateKey?: string;
  hypKey?: string;
  skipConfirmationPrompts?: boolean;
}): ProcessPromise {
  return $`${
    hypKey ? ['HYP_KEY=' + hypKey] : []
  } ${localTestRunCmdPrefix()} hyperlane ica deploy \
        --registry ${REGISTRY_PATH} \
        ${origin ? ['--origin', origin] : []} \
        ${chains?.length ? chains.flatMap((d) => ['--chains', d]) : []} \
        ${owner ? ['--owner', owner] : []} \
        ${privateKey ? ['--key', privateKey] : []} \
        --verbosity debug \
        ${skipConfirmationPrompts ? ['--yes'] : []}`;
}

/**
 * Deploys ICAs on destination chains for a specified owner on the origin chain.
 */
export function hyperlaneIcaDeploy(
  origin: ChainName,
  chains: ChainName[],
  owner: Address,
): ProcessPromise {
  return hyperlaneIcaDeployRaw({
    origin,
    chains,
    owner,
    privateKey: ANVIL_KEY,
    skipConfirmationPrompts: true,
  });
}
