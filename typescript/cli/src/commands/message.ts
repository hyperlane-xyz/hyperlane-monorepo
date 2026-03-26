import { ethers } from 'ethers';
import type { CommandModule } from 'yargs';

import {
  ProtocolType,
  addressToBytes32,
  bytesToProtocolAddress,
  formatMessage,
  messageId,
  parseMessage,
  parseWarpRouteMessage,
  strip0x,
} from '@hyperlane-xyz/utils';

import { type CommandModuleWithContext } from '../context/types.js';
import { log, logGreen } from '../logger.js';

function bytes32WithAddress(
  bytes32: string,
  protocol?: ProtocolType,
  bech32Prefix?: string,
): string {
  if (!protocol) return bytes32;
  try {
    const bytes = new Uint8Array(Buffer.from(strip0x(bytes32), 'hex'));
    const address = bytesToProtocolAddress(bytes, protocol, bech32Prefix);
    return `${bytes32} (${address})`;
  } catch {
    return bytes32;
  }
}

export const messageCommand: CommandModule = {
  command: 'message',
  describe: 'Hyperlane message encoding and decoding utilities',
  builder: (yargs) =>
    yargs
      .command(decodeMessageCommand)
      .command(encodeMessageCommand)
      .demandCommand(),
  handler: () => log('Command required'),
};

interface DecodeMessageArgs {
  bytes: string;
}

const decodeMessageCommand: CommandModuleWithContext<DecodeMessageArgs> = {
  command: 'decode',
  describe: 'Decode a packed Hyperlane message hex string',
  builder: {
    bytes: {
      type: 'string',
      description: 'Packed message hex string (with or without 0x)',
      demandOption: true,
      alias: 'b',
    },
  },
  handler: async (argv) => {
    const { bytes, context } = argv;

    const parsed = parseMessage(bytes);
    const id = messageId(bytes);

    const originChain = context.multiProvider.tryGetChainName(parsed.origin);
    const destChain = context.multiProvider.tryGetChainName(parsed.destination);
    const originMetadata = originChain
      ? context.multiProvider.tryGetChainMetadata(originChain)
      : null;
    const destMetadata = destChain
      ? context.multiProvider.tryGetChainMetadata(destChain)
      : null;

    logGreen(`Message ID:  ${id}`);
    log(`Version:     ${parsed.version}`);
    log(`Nonce:       ${parsed.nonce}`);
    log(
      `Origin:      ${parsed.origin}${originChain ? ` (${originChain})` : ''}`,
    );
    log(
      `Sender:      ${bytes32WithAddress(parsed.sender, originMetadata?.protocol, originMetadata?.bech32Prefix)}`,
    );
    log(
      `Destination: ${parsed.destination}${destChain ? ` (${destChain})` : ''}`,
    );
    log(
      `Recipient:   ${bytes32WithAddress(parsed.recipient, destMetadata?.protocol, destMetadata?.bech32Prefix)}`,
    );
    // Warp transfer body is exactly 64 bytes (bytes32 recipient + uint256 amount)
    const isWarpBody = /^0x[0-9a-fA-F]{128}$/.test(parsed.body);
    if (isWarpBody) {
      const warp = parseWarpRouteMessage(parsed.body);
      log(`Body (warp transfer):`);
      log(
        `  Recipient: ${bytes32WithAddress(warp.recipient, destMetadata?.protocol, destMetadata?.bech32Prefix)}`,
      );
      log(`  Amount:    ${warp.amount.toString()}`);
    } else {
      log(`Body:        ${parsed.body}`);
    }
  },
};

interface EncodeMessageArgs {
  msgVersion: number;
  nonce: number;
  origin: string;
  sender: string;
  destination: string;
  recipient: string;
  body?: string;
  warpRecipient?: string;
  warpAmount?: string;
}

const encodeMessageCommand: CommandModuleWithContext<EncodeMessageArgs> = {
  command: 'encode',
  describe: 'Encode a Hyperlane message to packed hex bytes',
  builder: {
    msgVersion: {
      type: 'number',
      description: 'Message version',
      default: 3,
    },
    nonce: {
      type: 'number',
      description: 'Message nonce',
      demandOption: true,
      alias: 'n',
    },
    origin: {
      type: 'string',
      description: 'Origin chain name or domain ID',
      demandOption: true,
      alias: 'o',
    },
    sender: {
      type: 'string',
      description: 'Sender address (auto-converted to bytes32)',
      demandOption: true,
    },
    destination: {
      type: 'string',
      description: 'Destination chain name or domain ID',
      demandOption: true,
      alias: 'd',
    },
    recipient: {
      type: 'string',
      description: 'Recipient address (auto-converted to bytes32)',
      demandOption: true,
    },
    body: {
      type: 'string',
      description: 'Message body as hex string (default: 0x)',
    },
    warpRecipient: {
      type: 'string',
      description:
        'Warp route recipient address — builds warp message body automatically',
    },
    warpAmount: {
      type: 'string',
      description: 'Warp route token amount (required with --warp-recipient)',
    },
  },
  handler: async (argv) => {
    const {
      msgVersion,
      nonce,
      origin,
      sender,
      destination,
      recipient,
      body,
      warpRecipient,
      warpAmount,
      context,
    } = argv;

    let messageBody = body ?? '0x';

    if (warpRecipient) {
      if (!warpAmount) {
        throw new Error('--warp-amount is required with --warp-recipient');
      }
      const recipientBytes32 = addressToBytes32(warpRecipient);
      messageBody = ethers.utils.solidityPack(
        ['bytes32', 'uint256'],
        [recipientBytes32, BigInt(warpAmount)],
      );
    }

    const originId = Number.isNaN(Number(origin))
      ? context.multiProvider.getDomainId(origin)
      : Number(origin);
    const destId = Number.isNaN(Number(destination))
      ? context.multiProvider.getDomainId(destination)
      : Number(destination);
    const originChain = context.multiProvider.tryGetChainName(originId);
    const destChain = context.multiProvider.tryGetChainName(destId);

    const packed = formatMessage(
      msgVersion,
      nonce,
      originId,
      sender,
      destId,
      recipient,
      messageBody,
    );
    const id = messageId(packed);

    logGreen(`Bytes:       ${packed}`);
    log(`Message ID:  ${id}`);
    log(`Version:     ${msgVersion}`);
    log(`Nonce:       ${nonce}`);
    log(`Origin:      ${originId}${originChain ? ` (${originChain})` : ''}`);
    log(`Sender:      ${addressToBytes32(sender)}`);
    log(`Destination: ${destId}${destChain ? ` (${destChain})` : ''}`);
    log(`Recipient:   ${addressToBytes32(recipient)}`);
    log(`Body:        ${messageBody}`);
  },
};
