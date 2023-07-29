import { ChainName } from '@hyperlane-xyz/sdk';

import { getDeployerContext } from '../context.js';

export async function sendTestMessage({
  key,
  chainConfigPath,
  origin,
  destination,
  timeout,
}: {
  key: string;
  chainConfigPath: string;
  origin: ChainName;
  destination: ChainName;
  timeout: number;
}) {
  getDeployerContext(key, chainConfigPath);
  // TODO migrate test-messages.ts here
  console.log(origin, destination, timeout);
}
