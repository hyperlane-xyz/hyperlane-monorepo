import { $, type ProcessPromise } from 'zx';

import { type ChainName } from '@hyperlane-xyz/sdk';

import { REGISTRY_PATH } from '../consts.js';

import { localTestRunCmdPrefix } from './helpers.js';

$.verbose = true;

export function hyperlaneXerc20ApplyRaw({
  warpRouteId,
  chains,
  privateKey,
  receiptsDir,
}: {
  warpRouteId: string;
  chains?: ChainName[];
  privateKey?: string;
  receiptsDir?: string;
}): ProcessPromise {
  return $`${localTestRunCmdPrefix()} hyperlane xerc20 apply \
        --registry ${REGISTRY_PATH} \
        --warp-route-id ${warpRouteId} \
        ${chains?.length ? chains.flatMap((d) => ['--chains', d]) : []} \
        ${privateKey ? ['--key', privateKey] : []} \
        ${receiptsDir ? ['--receipts', receiptsDir] : []} \
        --verbosity debug`;
}

export function hyperlaneXerc20ReadRaw({
  warpRouteId,
  chains,
}: {
  warpRouteId: string;
  chains?: ChainName[];
}): ProcessPromise {
  return $`${localTestRunCmdPrefix()} hyperlane xerc20 read \
        --registry ${REGISTRY_PATH} \
        --warp-route-id ${warpRouteId} \
        ${chains?.length ? chains.flatMap((d) => ['--chains', d]) : []} \
        --verbosity debug`;
}
