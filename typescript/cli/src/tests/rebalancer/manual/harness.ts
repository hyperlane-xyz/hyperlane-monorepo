#!/usr/bin/env node
/**
 * Manual Test Harness for USDC Warp Route Rebalancer
 *
 * This script provides a CLI interface for manually testing the rebalancer
 * against forked mainnet chains.
 *
 * Usage:
 *   pnpm --filter @hyperlane-xyz/cli tsx src/tests/rebalancer/manual/harness.ts [command]
 *
 * Commands:
 *   setup      - Start forked chains and deploy mocks
 *   status     - Show current balances across chains
 *   imbalance  - Set warp route balance on a chain
 *   rebalance  - Run rebalancer against forked chains
 *   cleanup    - Stop all forked chains
 */
import { ethers } from 'ethers';
import http from 'http';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';

import { getContext } from '../../../context/context.js';
import { writeYamlOrJson } from '../../../utils/files.js';
import { hyperlaneRelayer } from '../../ethereum/commands/helpers.js';
import { hyperlaneWarpRebalancer } from '../../ethereum/commands/warp.js';
import { ANVIL_KEY } from '../../ethereum/consts.js';
import {
  type ForkHarnessResult,
  MAINNET_CCTP_WARP_ROUTE_CONFIG,
  type SupportedChain,
  forkChainsForRebalancer,
  getWarpRouteUsdcBalance,
  setWarpRouteUsdcBalance,
  setupForkedChainsForRebalancer,
} from '../fork/rebalancer-fork-utils.js';

// Global state
let harness: ForkHarnessResult | null = null;

const DEFAULT_CHAINS: SupportedChain[] = ['ethereum', 'arbitrum', 'base'];
const REBALANCER_CONFIG_PATH = path.join(
  process.cwd(),
  'rebalancer-harness-config.yaml',
);

interface SetupOptions {
  chains: string;
  port: number;
}

interface StatusOptions {
  chains: string;
  port: number;
}

interface ImbalanceOptions {
  chain: string;
  balance: number;
  port: number;
  chains: string;
}

interface RebalanceOptions {
  monitorOnly?: boolean;
  config: string;
  registry: string;
}

interface RelayOptions {
  chains: string;
}

void yargs(hideBin(process.argv))
  .scriptName('rebalancer-harness')
  .usage('$0 <command> [options]')
  .command<SetupOptions>(
    'setup',
    'Fork chains and set up mocks for rebalancer testing',
    (yargs) =>
      yargs
        .option('chains', {
          type: 'string',
          default: DEFAULT_CHAINS.join(','),
          describe: 'Comma-separated list of chains to fork',
        })
        .option('port', {
          type: 'number',
          default: 8545,
          describe: 'Starting port for Anvil nodes',
        }),
    async (argv) => {
      const chains = argv.chains.split(',') as SupportedChain[];
      const basePort = argv.port;

      console.log('Setting up fork harness...');
      console.log(`Chains: ${chains.join(', ')}`);
      console.log(`Base port: ${basePort}`);

      try {
        const context = await getContext({
          registryUris: [DEFAULT_GITHUB_REGISTRY],
          key: ANVIL_KEY,
        });

        harness = await forkChainsForRebalancer(context, chains, basePort);

        const rebalancerAddress = new ethers.Wallet(ANVIL_KEY).address;
        await setupForkedChainsForRebalancer(harness, rebalancerAddress);

        // Create default rebalancer config
        const config = {
          warpRouteId: MAINNET_CCTP_WARP_ROUTE_CONFIG.warpRouteId,
          strategy: {
            rebalanceStrategy: 'minAmount',
            chains: Object.fromEntries(
              chains.map((chain) => [
                chain,
                {
                  minAmount: {
                    min: '5000000000',
                    target: '10000000000',
                    type: 'absolute',
                  },
                  bridge:
                    MAINNET_CCTP_WARP_ROUTE_CONFIG.chains[chain].warpRoute,
                  bridgeLockTime: 1800,
                  bridgeMinAcceptedAmount: '1000000000',
                },
              ]),
            ),
          },
        };
        writeYamlOrJson(REBALANCER_CONFIG_PATH, config);

        console.log('\nHarness setup complete!');
        console.log(`\nRegistry URL: ${harness.registryUrl}`);
        console.log(`Config written to: ${REBALANCER_CONFIG_PATH}`);
        console.log('\nForked chain endpoints:');
        for (const [chainName, fork] of harness.forks) {
          console.log(`  ${chainName}: ${fork.endpoint}`);
        }
        console.log('\nKeep this process running. Press Ctrl+C to cleanup.');

        // Keep process alive
        await new Promise(() => {});
      } catch (error) {
        console.error('Setup failed:', error);
        process.exit(1);
      }
    },
  )
  .command<StatusOptions>(
    'status',
    'Show current USDC balances on warp routes',
    (yargs) =>
      yargs
        .option('chains', {
          type: 'string',
          default: DEFAULT_CHAINS.join(','),
          describe: 'Comma-separated list of chains',
        })
        .option('port', {
          type: 'number',
          default: 8545,
          describe: 'Starting port for Anvil nodes',
        }),
    async (argv) => {
      const chains = argv.chains.split(',') as SupportedChain[];
      const basePort = argv.port;

      console.log('Fetching USDC balances...\n');

      try {
        let port = basePort;
        for (const chain of chains) {
          const provider = new ethers.providers.JsonRpcProvider(
            `http://127.0.0.1:${port}`,
          );
          try {
            await provider.getNetwork();
            const balance = await getWarpRouteUsdcBalance(provider, chain);
            const formattedBalance = (Number(balance) / 1e6).toLocaleString();
            console.log(
              `  ${chain.padEnd(12)} ${formattedBalance.padStart(15)} USDC`,
            );
          } catch {
            console.log(`  ${chain.padEnd(12)} (not running)`);
          }
          port++;
        }
      } catch (error) {
        console.error('Failed to fetch status:', error);
        process.exit(1);
      }
    },
  )
  .command<ImbalanceOptions>(
    'imbalance',
    'Set USDC balance on a warp route',
    (yargs) =>
      yargs
        .option('chain', {
          type: 'string',
          demandOption: true,
          describe: 'Chain to modify',
        })
        .option('balance', {
          type: 'number',
          demandOption: true,
          describe: 'Balance in USDC (e.g., 10000)',
        })
        .option('port', {
          type: 'number',
          default: 8545,
          describe: 'Starting port for Anvil nodes',
        })
        .option('chains', {
          type: 'string',
          default: DEFAULT_CHAINS.join(','),
          describe: 'Comma-separated list of all chains',
        }),
    async (argv) => {
      const chain = argv.chain as SupportedChain;
      const balance = BigInt(Math.floor(argv.balance * 1e6));
      const basePort = argv.port;
      const chains = argv.chains.split(',') as SupportedChain[];

      const chainIndex = chains.indexOf(chain);
      if (chainIndex === -1) {
        console.error(`Chain ${chain} not in fork list: ${chains.join(', ')}`);
        process.exit(1);
      }

      const port = basePort + chainIndex;

      try {
        const provider = new ethers.providers.JsonRpcProvider(
          `http://127.0.0.1:${port}`,
        );
        await provider.getNetwork();

        await setWarpRouteUsdcBalance(provider, chain, balance);

        const newBalance = await getWarpRouteUsdcBalance(provider, chain);
        console.log(
          `Set ${chain} balance to ${(Number(newBalance) / 1e6).toLocaleString()} USDC`,
        );
      } catch (error) {
        console.error('Failed to set balance:', error);
        process.exit(1);
      }
    },
  )
  .command<RebalanceOptions>(
    'rebalance',
    'Run the rebalancer against forked chains',
    (yargs) =>
      yargs
        .option('monitor-only', {
          type: 'boolean',
          default: false,
          describe: 'Run in monitor-only mode (no execution)',
        })
        .option('config', {
          type: 'string',
          default: REBALANCER_CONFIG_PATH,
          describe: 'Path to rebalancer config',
        })
        .option('registry', {
          type: 'string',
          demandOption: true,
          describe:
            'HTTP registry URL from setup command (e.g., http://127.0.0.1:8535)',
        }),
    async (argv) => {
      console.log('Starting rebalancer...');
      console.log(`Config: ${argv.config}`);
      console.log(`Registry: ${argv.registry}`);
      console.log(`Monitor only: ${argv.monitorOnly}`);

      try {
        // Create mock explorer server
        const server = http.createServer((req, res) => {
          if (req.method === 'POST') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data: { message_view: [] } }));
          } else {
            res.statusCode = 404;
            res.end();
          }
        });

        await new Promise<void>((resolve) => server.listen(0, resolve));
        const address = server.address();
        const port =
          typeof address === 'object' && address !== null ? address.port : 0;
        const explorerUrl = `http://127.0.0.1:${port}`;

        console.log(`Mock explorer at: ${explorerUrl}`);

        const rebalancer = hyperlaneWarpRebalancer(
          10000, // Check every 10 seconds
          argv.config,
          false, // withMetrics
          argv.monitorOnly || false,
          false, // manual
          undefined,
          undefined,
          undefined,
          ANVIL_KEY,
          explorerUrl,
          [argv.registry], // Pass the HTTP registry URL
        );

        // Stream output
        for await (const chunk of rebalancer.stdout) {
          process.stdout.write(chunk);
        }
      } catch (error) {
        console.error('Rebalancer failed:', error);
        process.exit(1);
      }
    },
  )
  .command<RelayOptions>(
    'relay',
    'Start relayer for forked chains',
    (yargs) =>
      yargs.option('chains', {
        type: 'string',
        default: DEFAULT_CHAINS.join(','),
        describe: 'Comma-separated list of chains',
      }),
    async (argv) => {
      const chains = argv.chains.split(',');
      console.log(`Starting relayer for chains: ${chains.join(', ')}`);

      try {
        const relayer = hyperlaneRelayer(chains);

        // Stream output
        for await (const chunk of relayer.stdout) {
          process.stdout.write(chunk);
        }
      } catch (error) {
        console.error('Relayer failed:', error);
        process.exit(1);
      }
    },
  )
  .command('cleanup', 'Cleanup instructions', () => {
    console.log('To cleanup:');
    console.log('1. Press Ctrl+C in the setup terminal');
    console.log('2. Or kill Anvil processes: pkill -f anvil');
    console.log(`3. Remove config: rm ${REBALANCER_CONFIG_PATH}`);
  })
  .demandCommand(1, 'You need to specify a command')
  .strict()
  .help()
  .parse();
