import { spawn } from 'child_process';

import { getArgs, withChainRequired } from './agent-utils.js';
import { getEnvironmentConfig } from './core-utils.js';

async function getRpcUrl() {
  const { environment, chain } = await withChainRequired(getArgs()).argv;
  const environmentConfig = getEnvironmentConfig(environment);
  const registry = await environmentConfig.getRegistry(true);

  const chainMetadata = await registry.getChainMetadata(chain);
  if (!chainMetadata) {
    throw Error(`Unsupported chain: ${chain}`);
  }

  return chainMetadata.rpcUrls[0].http;
}

async function runAnvil(rpcUrl: string) {
  const anvilProcess = spawn(
    'anvil',
    [
      '--fork-url',
      rpcUrl,
      '--fork-retry-backoff',
      '3',
      '--compute-units-per-second',
      '200',
      '--gas-price',
      '1',
    ],
    {
      detached: false,
      stdio: ['ignore', 'ignore', 'ignore'],
    },
  );

  anvilProcess.on('exit', (code) => {
    console.log(`Anvil process exited with code ${code}`);
    process.exit(code || 0);
  });

  anvilProcess.on('error', (err) => {
    console.error(`Failed to start Anvil: ${err}`);
    process.exit(1);
  });

  return anvilProcess.pid;
}

async function main() {
  const rpcUrl = await getRpcUrl();
  const anvilPid = await runAnvil(rpcUrl);

  console.log(`Anvil PID: ${anvilPid}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
