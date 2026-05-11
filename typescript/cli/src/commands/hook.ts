import { type CommandModule } from 'yargs';

import {
  type CommandModuleWithContext,
  type CommandModuleWithWriteContext,
} from '../context/types.js';
import { runHookApply } from '../hook/apply.js';
import { runHookDeploy } from '../hook/deploy.js';
import { readHookConfig } from '../hook/read.js';
import { log, logGray } from '../logger.js';

import {
  addressCommandOption,
  chainCommandOption,
  inputFileCommandOption,
  outputFileCommandOption,
  strategyCommandOption,
} from './options.js';

/**
 * Parent command
 */
export const hookCommand: CommandModule = {
  command: 'hook',
  describe: 'Operations relating to Hooks',
  builder: (yargs) =>
    yargs
      .command(apply)
      .command(deploy)
      .command(read)
      .version(false)
      .demandCommand(),
  handler: () => log('Command required'),
};

// Examples for testing:
// Apply updates to an IGP hook on a Sealevel chain:
//     hyperlane hook apply --chain svmlocal1 --address <hook-pda> --config ./igp-hook-config.yaml --key.sealevel <key>
export const apply: CommandModuleWithWriteContext<{
  chain: string;
  address: string;
  config: string;
  strategy?: string;
}> = {
  command: 'apply',
  describe:
    'Applies a hook configuration to an existing on-chain hook, generating the minimal set of update transactions',
  builder: {
    chain: {
      ...chainCommandOption,
      demandOption: true,
    },
    address: addressCommandOption('Address of the Hook to update.', true),
    config: inputFileCommandOption({
      description: 'Path to hook configuration file (YAML or JSON)',
      demandOption: true,
    }),
    strategy: { ...strategyCommandOption, demandOption: false },
  },
  handler: async ({ context, chain, address, config, strategy }) => {
    await runHookApply({
      context,
      chain,
      address,
      configPath: config,
      strategyUrl: strategy,
    });
    process.exit(0);
  },
};

// Examples for testing:
// Deploy an IGP hook on a Sealevel chain:
//     hyperlane hook deploy --chain svmlocal1 --config ./igp-hook-config.yaml --key.sealevel <key>
// Deploy with output file:
//     hyperlane hook deploy --chain svmlocal1 --config ./igp-hook-config.yaml --out ./deployed-hook.json
export const deploy: CommandModuleWithWriteContext<{
  chain: string;
  config: string;
  out?: string;
}> = {
  command: 'deploy',
  describe: 'Deploys a hook to a chain',
  builder: {
    chain: {
      ...chainCommandOption,
      demandOption: true,
    },
    config: inputFileCommandOption({
      description: 'Path to hook configuration file (YAML or JSON)',
      demandOption: true,
    }),
    out: outputFileCommandOption(
      undefined,
      false,
      'Output file path for deployed hook address',
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
  },
  handler: async (args) => {
    logGray('Hyperlane Hook Read');
    logGray('------------------');
    await readHookConfig(args);
    process.exit(0);
  },
};
