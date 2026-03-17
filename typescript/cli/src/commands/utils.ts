import type { CommandModule } from 'yargs';

import {
  ProtocolType,
  addressToBytes32,
  bytesToProtocolAddress,
  ensure0x,
  strip0x,
} from '@hyperlane-xyz/utils';

import { type CommandModuleWithContext } from '../context/types.js';
import { log, logGreen } from '../logger.js';

/**
 * Parent command for address conversion utilities
 */
export const addressCommand: CommandModule = {
  command: 'address',
  describe: 'Address conversion utilities for Hyperlane',
  builder: (yargs) =>
    yargs
      .command(addressToBytes32Command)
      .command(bytes32ToAddressCommand)
      .demandCommand(),
  handler: () => log('Command required'),
};

/**
 * Converts an address to bytes32 format
 */
interface AddressToBytes32Args {
  address: string;
  protocol?: ProtocolType;
}

const addressToBytes32Command: CommandModule<{}, AddressToBytes32Args> = {
  command: 'to-bytes32',
  describe: 'Convert an address to bytes32 format (used in Hyperlane messages)',
  builder: (yargs) =>
    yargs
      .option('address', {
        type: 'string',
        description: 'The address to convert',
        demandOption: true,
        alias: 'a',
      })
      .option('protocol', {
        type: 'string',
        description:
          'Protocol type (ethereum, sealevel, cosmos, cosmosnative, starknet, radix, aleo, tron). Auto-detected if not specified.',
        choices: Object.values(ProtocolType),
        alias: 'p',
      }),
  handler: async (argv) => {
    const { address, protocol } = argv;
    try {
      const bytes32 = addressToBytes32(address, protocol);
      logGreen(`Address: ${address}`);
      if (protocol) log(`Protocol: ${protocol}`);
      log(`Bytes32: ${bytes32}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to convert address: ${message}`, {
        cause: error,
      });
    }
  },
};

/**
 * Get display name for a protocol type
 */
function getProtocolDisplayName(protocol: ProtocolType): string {
  switch (protocol) {
    case ProtocolType.Ethereum:
      return 'Ethereum (EVM)';
    case ProtocolType.Tron:
      return 'Tron';
    case ProtocolType.Cosmos:
      return 'Cosmos';
    case ProtocolType.CosmosNative:
      return 'CosmosNative';
    default:
      return protocol;
  }
}

/**
 * Get additional padding info for protocols that support module IDs
 */
function getAdditionalPaddingInfo(protocol: ProtocolType): string {
  if (
    protocol === ProtocolType.CosmosNative ||
    protocol === ProtocolType.Cosmos
  ) {
    return '\n\nIf this is a Hyperlane Cosmos module ID (not an account address), the bytes32 will be returned as-is in hex format.';
  }
  return '';
}

/**
 * Converts bytes32 to an address
 */
interface Bytes32ToAddressArgs {
  bytes32: string;
  protocol: ProtocolType;
  prefix?: string;
  chain?: string;
}

const bytes32ToAddressCommand: CommandModuleWithContext<Bytes32ToAddressArgs> =
  {
    command: 'from-bytes32',
    describe: 'Convert bytes32 to an address for a specific protocol',
    builder: {
      bytes32: {
        type: 'string',
        description: 'The bytes32 hex string to convert (with or without 0x)',
        demandOption: true,
        alias: 'b',
      },
      protocol: {
        type: 'string',
        description: 'Target protocol type',
        choices: Object.values(ProtocolType),
        demandOption: true,
        alias: 'p',
      },
      prefix: {
        type: 'string',
        description:
          'Address prefix (e.g., "osmo", "neutron", "cosmos"). Required for Cosmos chains unless --chain is provided.',
      },
      chain: {
        type: 'string',
        description:
          'Chain name to automatically lookup the prefix from registry (e.g., "osmosis", "neutron")',
        alias: 'c',
        conflicts: 'prefix',
      },
    },
    handler: async (argv) => {
      const { bytes32, protocol, prefix, chain, context } = argv;
      try {
        // Validate bytes32 format
        const normalizedBytes32 = ensure0x(bytes32);
        if (!/^0x[a-fA-F0-9]{64}$/.test(normalizedBytes32)) {
          throw new Error(
            'Invalid bytes32 format. Expected 32-byte hex string.',
          );
        }

        // Resolve prefix from chain if provided
        let resolvedPrefix = prefix;
        if (chain) {
          const chainMetadata = await context.registry.getChainMetadata(chain);
          if (!chainMetadata) {
            throw new Error(`Chain '${chain}' not found in registry`);
          }
          if (!chainMetadata.bech32Prefix) {
            throw new Error(
              `Chain '${chain}' does not have a bech32Prefix in metadata`,
            );
          }
          resolvedPrefix = chainMetadata.bech32Prefix;
        }

        // Check if prefix is required
        if (
          (protocol === ProtocolType.Cosmos ||
            protocol === ProtocolType.CosmosNative ||
            protocol === ProtocolType.Radix) &&
          !resolvedPrefix
        ) {
          throw new Error(
            `Prefix is required for ${protocol} addresses. Use --prefix or --chain to provide one. Example prefixes: osmo, neutron, cosmos, account_rdx`,
          );
        }

        // Convert to Uint8Array
        const bytes = new Uint8Array(
          Buffer.from(strip0x(normalizedBytes32), 'hex'),
        );

        // Check for address padding requirements (20-byte addresses need 12 zero bytes padding)
        if (
          (protocol === ProtocolType.Ethereum ||
            protocol === ProtocolType.Tron ||
            protocol === ProtocolType.Cosmos ||
            protocol === ProtocolType.CosmosNative) &&
          bytes.length === 32
        ) {
          const first12Bytes = bytes.slice(0, 12);
          const hasCorrectPadding = first12Bytes.every((b) => b === 0);

          if (!hasCorrectPadding) {
            const protocolName = getProtocolDisplayName(protocol);
            const additionalInfo = getAdditionalPaddingInfo(protocol);

            throw new Error(
              `${protocolName} addresses are 20 bytes and must have 12 zero bytes (24 hex characters) of padding at the start.\n` +
                `Expected format: 0x${'0'.repeat(24)}<20-byte-address>\n` +
                `Your input:       ${normalizedBytes32}${additionalInfo}`,
            );
          }
        }

        const address = bytesToProtocolAddress(bytes, protocol, resolvedPrefix);

        logGreen(`Bytes32: ${normalizedBytes32}`);
        log(`Protocol: ${protocol}`);
        if (chain) log(`Chain: ${chain}`);
        if (resolvedPrefix) log(`Prefix: ${resolvedPrefix}`);
        log(`Address: ${address}`);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to convert bytes32: ${message}`);
      }
    },
  };
