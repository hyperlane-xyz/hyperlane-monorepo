import { ChainName } from '@hyperlane-xyz/sdk';

import { getDeployerContext } from '../context.js';

export async function sendTestTrasfer({
  key,
  chainConfigPath,
  origin,
  destination,
  wei,
  recipient,
  timeout,
}: {
  key: string;
  chainConfigPath: string;
  origin: ChainName;
  destination: ChainName;
  wei: number;
  recipient?: string;
  timeout: number;
}) {
  getDeployerContext(key, chainConfigPath);
  // TODO migrate test-warp-transfer.ts here
  console.log(origin, destination, wei, recipient, timeout);
}
