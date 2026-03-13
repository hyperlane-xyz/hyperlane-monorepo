import type { CommandModule } from 'yargs';

import {
  ProtocolType,
  addressToBytes32,
  bytesToProtocolAddress,
  ensure0x,
  strip0x,
} from '@hyperlane-xyz/utils';

import { log, logGreen } from '../logger.js';

/**
 * Parent command for utility functions
 */
export const utilsCommand: CommandModule = {
  command: 'utils',
  describe: 'Utility commands for common operations',
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
  command: 'addressToBytes32 <address> [protocol]',
  describe: 'Convert an address to bytes32 format (used in Hyperlane messages)',
  builder: (yargs) =>
    yargs
      .positional('address', {
        type: 'string',
        description: 'The address to convert',
        demandOption: true,
      })
      .positional('protocol', {
        type: 'string',
        description:
          'Protocol type (ethereum, sealevel, cosmos, cosmosnative, starknet, radix, aleo, tron). Auto-detected if not specified.',
        choices: Object.values(ProtocolType),
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
      throw new Error(`Failed to convert address: ${message}`);
    }
  },
};

/**
 * Converts bytes32 to an address
 */
interface Bytes32ToAddressArgs {
  bytes32: string;
  protocol: ProtocolType;
  prefix?: string;
}

const bytes32ToAddressCommand: CommandModule<{}, Bytes32ToAddressArgs> = {
  command: 'bytes32ToAddress <bytes32> <protocol> [prefix]',
  describe: 'Convert bytes32 to an address for a specific protocol',
  builder: (yargs) =>
    yargs
      .positional('bytes32', {
        type: 'string',
        description: 'The bytes32 hex string to convert (with or without 0x)',
        demandOption: true,
      })
      .positional('protocol', {
        type: 'string',
        description: 'Target protocol type',
        choices: Object.values(ProtocolType),
        demandOption: true,
      })
      .positional('prefix', {
        type: 'string',
        description:
          'Address prefix (required for Cosmos chains, e.g., "osmo", "neutron", "cosmos")',
      }),
  handler: async (argv) => {
    const { bytes32, protocol, prefix } = argv;
    try {
      // Validate bytes32 format
      const normalizedBytes32 = ensure0x(bytes32);
      if (!/^0x[a-fA-F0-9]{64}$/.test(normalizedBytes32)) {
        throw new Error('Invalid bytes32 format. Expected 32-byte hex string.');
      }

      // Check if prefix is required
      if (
        (protocol === ProtocolType.Cosmos ||
          protocol === ProtocolType.CosmosNative ||
          protocol === ProtocolType.Radix) &&
        !prefix
      ) {
        throw new Error(
          `Prefix is required for ${protocol} addresses. Example prefixes: osmo, neutron, cosmos, account_rdx`,
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
          const protocolName =
            protocol === ProtocolType.Ethereum
              ? 'Ethereum (EVM)'
              : protocol === ProtocolType.Tron
                ? 'Tron'
                : protocol === ProtocolType.Cosmos
                  ? 'Cosmos'
                  : 'CosmosNative';
          const additionalInfo =
            protocol === ProtocolType.CosmosNative ||
            protocol === ProtocolType.Cosmos
              ? '\n\nIf this is a Hyperlane Cosmos module ID (not an account address), the bytes32 will be returned as-is in hex format.'
              : '';

          throw new Error(
            `${protocolName} addresses are 20 bytes and must have 12 zero bytes (24 hex characters) of padding at the start.\n` +
              `Expected format: 0x${'0'.repeat(24)}<20-byte-address>\n` +
              `Your input:       ${normalizedBytes32}${additionalInfo}`,
          );
        }
      }

      const address = bytesToProtocolAddress(bytes, protocol, prefix);

      logGreen(`Bytes32: ${normalizedBytes32}`);
      log(`Protocol: ${protocol}`);
      if (prefix) log(`Prefix: ${prefix}`);
      log(`Address: ${address}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to convert bytes32: ${message}`);
    }
  },
};
