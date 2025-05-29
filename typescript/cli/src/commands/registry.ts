import { JsonRpcProvider } from '@ethersproject/providers';
import { CommandModule } from 'yargs';
import { $ } from 'zx';

import { resetFork } from '@hyperlane-xyz/sdk';
import { retryAsync } from '@hyperlane-xyz/utils';

import { createAgentConfig } from '../config/agent.js';
import { createChainConfig } from '../config/chain.js';
import { CommandContext, CommandModuleWithContext } from '../context/types.js';
import { errorRed, log, logBlue, logGray, logTable } from '../logger.js';

import {
  chainTargetsCommandOption,
  outputFileCommandOption,
} from './options.js';
import { ChainType, ChainTypes } from './types.js';

/**
 * Parent command
 */
export const registryCommand: CommandModule = {
  command: 'registry',
  describe: 'Manage Hyperlane chains in a registry',
  builder: (yargs) =>
    yargs
      .command(addressesCommand)
      .command(rpcCommand)
      .command(forkCommand)
      .command(createAgentConfigCommand)
      .command(initCommand)
      .command(listCommand)
      .version(false)
      .demandCommand(),
  handler: () => log('Command required'),
};

/**
 * List command
 */
const listCommand: CommandModuleWithContext<{ type: ChainType }> = {
  command: 'list',
  describe: 'List all chains included in a registry',
  builder: {
    type: {
      describe: 'Specify the type of chains',
      choices: ChainTypes,
    },
  },
  handler: async ({ type, context }) => {
    const logChainsForType = (type: ChainType) => {
      logBlue(`\nHyperlane ${type} chains:`);
      logGray('------------------------------');
      const chains = Object.values(context.chainMetadata).filter((c) => {
        if (type === 'mainnet') return !c.isTestnet;
        else return !!c.isTestnet;
      });
      const tableData = chains.reduce<any>((result, chain) => {
        const { chainId, displayName } = chain;
        result[chain.name] = {
          'Display Name': displayName,
          'Chain Id': chainId,
        };
        return result;
      }, {});
      logTable(tableData);
    };

    if (type) {
      logChainsForType(type);
    } else {
      logChainsForType('mainnet');
      logChainsForType('testnet');
    }
  },
};

/**
 * Addresses command
 */
const addressesCommand: CommandModuleWithContext<{
  name: string;
  contract: string;
}> = {
  command: 'addresses',
  aliases: ['address', 'addy'],
  describe: 'Display the addresses of core Hyperlane contracts',
  builder: {
    name: {
      type: 'string',
      description: 'Chain to display addresses for',
      alias: 'chain',
    },
    contract: {
      type: 'string',
      description: 'Specific contract name to print addresses for',
      implies: 'name',
    },
  },
  handler: async ({ name, context, contract }) => {
    if (name) {
      const result = await context.registry.getChainAddresses(name);
      if (contract && result?.[contract.toLowerCase()]) {
        // log only contract address for machine readability
        log(result[contract]);
        return;
      }

      logBlue('Hyperlane contract addresses for:', name);
      logGray('---------------------------------');
      log(JSON.stringify(result, null, 2));
    } else {
      const result = await context.registry.getAddresses();
      logBlue('Hyperlane contract addresses:');
      logGray('----------------------------------');
      log(JSON.stringify(result, null, 2));
    }
  },
};

const forkCommand: CommandModuleWithContext<{
  name: string;
  anvil: string;
  port: number;
}> = {
  command: 'fork',
  describe: 'Fork a Hyperlane chain on a compatible Anvil/Hardhat node',
  builder: {
    name: {
      type: 'string',
      description: 'Chain to fork',
      alias: 'chain',
      demandOption: true,
    },
    anvil: {
      type: 'string',
      description: 'URL of the Anvil/Hardhat compatible RPC endpoint',
      demandOption: false,
    },
    port: {
      type: 'number',
      description: 'Port to run Anvil on',
      default: 8545,
    },
  },
  handler: async ({ name, context, anvil, port }) => {
    const result = await context.registry.getChainMetadata(name);
    if (!result) {
      errorRed(`❌ Chain ${name} not found`);
      process.exit(1);
    }

    if (!anvil) {
      logGray(`Starting Anvil node on ${port}`);
      const anvilProcess = $`anvil --port ${port} --chain-id ${result.chainId}`;
      anvil = `http://localhost:${port}`;

      process.once('exit', () => anvilProcess.kill());
    }

    const provider = new JsonRpcProvider(anvil);
    await retryAsync(() => provider.getNetwork(), 10, 500);

    logGray(`Forking ${name} (latest block)`);
    await resetFork();
  },
};

const rpcCommand: CommandModuleWithContext<{
  name: string;
  index: number;
}> = {
  command: 'rpc',
  describe: 'Display the public rpc of a Hyperlane chain',
  builder: {
    name: {
      type: 'string',
      description: 'Chain to display addresses for',
      alias: 'chain',
      demandOption: true,
    },
    index: {
      type: 'number',
      description: 'Index of the rpc to display',
      default: 0,
      demandOption: false,
    },
  },
  handler: async ({ name, context, index }) => {
    const result = await context.registry.getChainMetadata(name);
    const rpcUrl = result?.rpcUrls[index]?.http;
    if (!rpcUrl) {
      errorRed(`❌ No rpc found for chain ${name}`);
      process.exit(1);
    }

    log(rpcUrl);
  },
};

/**
 * agent-config command
 */
const createAgentConfigCommand: CommandModuleWithContext<{
  chains?: string;
  out: string;
  skipPrompts: boolean;
}> = {
  command: 'agent-config',
  describe: 'Create a new agent config',
  builder: {
    chains: chainTargetsCommandOption,
    out: outputFileCommandOption(
      './configs/agent-config.json',
      false,
      'The path to output an agent config JSON file.',
    ),
  },
  handler: async ({
    context,
    chains,
    out,
  }: {
    context: CommandContext;
    chains?: string;
    out: string;
    skipPrompts: boolean;
  }) => {
    const { multiProvider } = context;

    let chainNames: string[] | undefined;
    if (chains) {
      chainNames = chains.split(',');
      const invalidChainNames = chainNames.filter(
        (chainName) => !multiProvider.hasChain(chainName),
      );
      if (invalidChainNames.length > 0) {
        errorRed(
          `❌ Invalid chain names: ${invalidChainNames
            .join(', ')
            .replace(/, $/, '')}`,
        );
        process.exit(1);
      }
    }

    await createAgentConfig({
      context,
      chains: chainNames,
      out,
    });
    process.exit(0);
  },
};

const initCommand: CommandModuleWithContext<{}> = {
  command: 'init',
  describe: 'Create a new, minimal Hyperlane chain config (aka chain metadata)',
  handler: async ({ context }) => {
    await createChainConfig({ context });
    process.exit(0);
  },
};
