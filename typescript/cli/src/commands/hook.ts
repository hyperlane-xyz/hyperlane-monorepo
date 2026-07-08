import { type CommandModule } from 'yargs';

import { assert } from '@hyperlane-xyz/utils';

import {
  type CommandModuleWithContext,
  type CommandModuleWithWriteContext,
} from '../context/types.js';
import { runHookDeploy } from '../hook/deploy.js';
import { readHookConfig } from '../hook/read.js';
import { log, logGray } from '../logger.js';

import {
  addressCommandOption,
  chainCommandOption,
  inputFileCommandOption,
  outputFileCommandOption,
} from './options.js';

/**
 * Parent command
 */
export const hookCommand: CommandModule = {
  command: 'hook',
  describe: 'Operations relating to Hooks',
  builder: (yargs) =>
    yargs.command(deploy).command(read).version(false).demandCommand(),
  handler: () => log('Command required'),
};

// Examples for testing:
// Deploy a merkle tree hook:
//     hyperlane hook deploy --chain sepolia --config ./hook-config.yaml
// Deploy with output file:
//     hyperlane hook deploy --chain sepolia --config ./hook-config.yaml --out ./deployed-hook.json
export const deploy: CommandModuleWithWriteContext<{
  chain: string;
  config: string;
  out?: string;
}> = {
  command: 'deploy',
  describe: 'Deploys a Hook to a chain',
  builder: {
    chain: {
      ...chainCommandOption,
      demandOption: true,
    },
    config: inputFileCommandOption({
      description: 'Path to Hook configuration file (YAML or JSON)',
      demandOption: true,
    }),
    out: outputFileCommandOption(
      undefined,
      false,
      'Output file path for deployed Hook address',
    ),
  },
  handler: async ({ context, chain, config, out }) => {
    await runHookDeploy({
      context,
      chain,
      configPath: config,
      outPath: out,
    });
    process.exit(0);
  },
};

// Examples for testing:
// Fallback routing hook on polygon (may take 5s):
//     hyperlane hook read --chain polygon --address 0xca4cCe24E7e06241846F5EA0cda9947F0507C40C
// IGP hook on inevm (may take 5s):
//     hyperlane hook read --chain inevm --address 0x19dc38aeae620380430C200a6E990D5Af5480117
export const read: CommandModuleWithContext<{
  chain: string;
  address: string;
  out: string;
  feeTokens?: string;
}> = {
  command: 'read',
  describe: 'Reads onchain Hook configuration for a given address',
  builder: {
    chain: {
      ...chainCommandOption,
      demandOption: true,
    },
    address: addressCommandOption('Address of the Hook to read.', true),
    out: outputFileCommandOption(),
    'fee-tokens': {
      type: 'string',
      description:
        'Comma-separated ERC20 fee token addresses to include token oracle config (IGP hooks only)',
      alias: 'ft',
    },
  },
  handler: async (args) => {
    logGray('Hyperlane Hook Read');
    logGray('------------------');
    await readHookConfig({
      ...args,
      feeTokens: args.feeTokens
        ? (() => {
            const tokens = args.feeTokens!.split(',').map((t) => t.trim());
            assert(
              tokens.every((t) => t.length > 0),
              '--fee-tokens contains an empty entry; check for trailing commas or double commas',
            );
            return tokens;
          })()
        : undefined,
    });
    process.exit(0);
  },
};
