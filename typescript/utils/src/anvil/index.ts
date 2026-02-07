import { type ChildProcess, spawn } from 'child_process';
import { providers } from 'ethers';

import { retryAsync, rootLogger } from '../index.js';

const LOCAL_HOST = 'http://127.0.0.1';

export interface AnvilForkResult {
  endpoint: string;
  provider: providers.JsonRpcProvider;
  kill: (isPanicking?: boolean) => void;
  process: ChildProcess;
}

export interface ForkChainOptions {
  rpcUrl: string;
  chainId: number;
  port: number;
  blockNumber?: number;
  disableBlockGasLimit?: boolean;
}

export async function forkChain(
  options: ForkChainOptions,
): Promise<AnvilForkResult> {
  const {
    rpcUrl,
    chainId,
    port,
    blockNumber,
    disableBlockGasLimit = true,
  } = options;

  const endpoint = `${LOCAL_HOST}:${port}`;

  rootLogger.debug({ chainId, port, rpcUrl }, 'Starting Anvil fork');

  const args = [
    '--port',
    String(port),
    '--chain-id',
    String(chainId),
    '--fork-url',
    rpcUrl,
  ];

  if (blockNumber !== undefined) {
    args.push('--fork-block-number', String(blockNumber));
  }

  if (disableBlockGasLimit) {
    args.push('--disable-block-gas-limit');
  }

  const anvilProcess = spawn('anvil', args, {
    stdio: 'ignore',
    detached: false,
  });

  const provider = new providers.JsonRpcProvider(endpoint);

  await retryAsync(() => provider.getNetwork(), 10, 500);

  rootLogger.debug({ chainId, port, endpoint }, 'Anvil fork ready');

  const kill = (isPanicking = false): void => {
    anvilProcess.kill(isPanicking ? 'SIGTERM' : 'SIGINT');
  };

  return {
    endpoint,
    provider,
    kill,
    process: anvilProcess,
  };
}
