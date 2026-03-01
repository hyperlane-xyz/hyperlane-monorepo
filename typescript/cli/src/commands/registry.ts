import { type CommandModule } from 'yargs';

import {
  EXTRACTABLE_SIGNER_TYPES,
  SignerFactory,
  SignerType,
  isSignerRef,
} from '@hyperlane-xyz/sdk';

import { createAgentConfig } from '../config/agent.js';
import { createChainConfig } from '../config/chain.js';
import {
  type CommandContext,
  type CommandModuleWithContext,
} from '../context/types.js';
import { errorRed, log, logBlue, logGray, logTable } from '../logger.js';
import { filterOutDisabledChains } from '../utils/chains.js';

import {
  chainTargetsCommandOption,
  outputFileCommandOption,
} from './options.js';
import { type ChainType, ChainTypes } from './types.js';

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
      .command(createAgentConfigCommand)
      .command(initCommand)
      .command(listCommand)
      .command(signerKeyCommand)
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
      const chains = Object.values(
        filterOutDisabledChains(context.chainMetadata),
      ).filter((c) => {
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
  chains?: string[];
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
    chains?: string[];
    out: string;
    skipPrompts: boolean;
  }) => {
    const { multiProvider } = context;

    let chainNames: string[] | undefined;
    if (chains?.length) {
      chainNames = chains;
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

/**
 * signer-key command
 *
 * Extracts the private key from a registry signer configuration.
 * Useful for passing keys to external tools like Foundry.
 */
const signerKeyCommand: CommandModuleWithContext<{
  name?: string;
  chain?: string;
  addressOnly: boolean;
}> = {
  command: 'signer-key',
  describe:
    'Extract the private key from a registry signer (for use with external tools)',
  builder: {
    name: {
      type: 'string',
      description:
        'Name of the signer to extract (from the signers map in registry)',
      alias: 'n',
    },
    chain: {
      type: 'string',
      description:
        'Chain name to get the signer for (uses chain-specific or default signer)',
      alias: 'c',
    },
    'address-only': {
      type: 'boolean',
      description: 'Only output the address, not the private key',
      default: false,
      alias: 'a',
    },
  },
  handler: async ({ name, chain, addressOnly, context }) => {
    const signerConfigResult = context.registry.getSignerConfiguration?.();
    const signerConfig = signerConfigResult
      ? await Promise.resolve(signerConfigResult)
      : null;

    if (!signerConfig) {
      errorRed(
        '❌ No signer configuration found in registry.\n' +
          'Use --registry with a signer registry URI like:\n' +
          '  --registry gcp://project/secret-name\n' +
          '  --registry foundry://account-name',
      );
      process.exit(1);
    }

    // Resolve the signer config
    let resolvedConfig;
    let signerSource: string;

    if (name) {
      // Get a specific named signer
      const namedSigner = signerConfig.signers?.[name];
      if (!namedSigner) {
        const availableSigners = Object.keys(signerConfig.signers || {});
        errorRed(
          `❌ Signer '${name}' not found in registry.\n` +
            (availableSigners.length > 0
              ? `Available signers: ${availableSigners.join(', ')}`
              : 'No named signers configured.'),
        );
        process.exit(1);
      }
      resolvedConfig = namedSigner;
      signerSource = `signer '${name}'`;
    } else {
      // Get the default signer (optionally for a specific chain)
      const defaults = signerConfig.defaults;
      if (!defaults) {
        errorRed(
          '❌ No default signer configured in registry.\n' +
            'Specify a signer name with --name or configure defaults in the registry.',
        );
        process.exit(1);
      }

      // Resolution order: chain > protocol > default
      let signerOrRef;
      if (chain && defaults.chains?.[chain]) {
        signerOrRef = defaults.chains[chain];
        signerSource = `chain '${chain}' default`;
      } else if (defaults.default) {
        signerOrRef = defaults.default;
        signerSource = 'default signer';
      } else {
        errorRed(
          '❌ No default signer configured.\n' +
            (chain
              ? `No signer configured for chain '${chain}' or as default.`
              : 'Specify --chain or --name to select a signer.'),
        );
        process.exit(1);
      }

      // Resolve refs
      if (isSignerRef(signerOrRef)) {
        const refName = signerOrRef.ref;
        const refSigner = signerConfig.signers?.[refName];
        if (!refSigner) {
          errorRed(`❌ Signer ref '${refName}' not found in signers map.`);
          process.exit(1);
        }
        resolvedConfig = refSigner;
        signerSource = `${signerSource} (ref: '${refName}')`;
      } else {
        resolvedConfig = signerOrRef;
      }
    }

    // Check if the signer type supports extraction
    if (!SignerFactory.isExtractable(resolvedConfig)) {
      const extractableTypes = EXTRACTABLE_SIGNER_TYPES.join(', ');

      if (resolvedConfig.type === SignerType.FOUNDRY_KEYSTORE) {
        errorRed(
          `❌ Foundry keystore signers do not support key extraction via this command.\n` +
            `Use Foundry's native command instead:\n\n` +
            `  cast wallet decrypt-keystore ${(resolvedConfig as any).accountName}\n`,
        );
      } else if (resolvedConfig.type === SignerType.TURNKEY) {
        errorRed(
          `❌ Turnkey signers do not support key extraction.\n` +
            `Keys are managed in secure enclaves and cannot be exported.`,
        );
      } else {
        errorRed(
          `❌ Signer type '${resolvedConfig.type}' does not support key extraction.\n` +
            `Supported types: ${extractableTypes}`,
        );
      }
      process.exit(1);
    }

    try {
      logGray(`Extracting key from ${signerSource}...`);
      const extracted = await SignerFactory.extractPrivateKey(resolvedConfig);

      if (addressOnly) {
        // Output only the address for scripting
        log(extracted.address);
      } else {
        // Output the private key (for piping to other tools)
        log(extracted.privateKey);
      }
    } catch (error: any) {
      errorRed(`❌ Failed to extract key: ${error.message}`);
      process.exit(1);
    }
  },
};
