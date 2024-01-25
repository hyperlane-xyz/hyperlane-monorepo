import { ethers } from 'ethers';
import { CommandModule, Options } from 'yargs';

import { TokenType } from '@hyperlane-xyz/sdk';

import { log } from '../../logger.js';
import { sendTestMessage } from '../send/message.js';
import { sendTestTransfer } from '../send/transfer.js';

import {
  chainsCommandOption,
  coreArtifactsOption,
  keyCommandOption,
} from './options.js';

/**
 * Parent command
 */
export const sendCommand: CommandModule = {
  command: 'send',
  describe: 'Send a test message or transfer',
  builder: (yargs) =>
    yargs
      .command(messageCommand)
      .command(transferCommand)
      .version(false)
      .demandCommand(),
  handler: () => log('Command required'),
};

/**
 * Message command
 */
const messageOptions: { [k: string]: Options } = {
  key: keyCommandOption,
  origin: {
    type: 'string',
    description: 'Origin chain to send message from',
  },
  destination: {
    type: 'string',
    description: 'Destination chain to send message to',
  },
  chains: chainsCommandOption,
  core: coreArtifactsOption,
  timeout: {
    type: 'number',
    description: 'Timeout in seconds',
    default: 5 * 60,
  },
  quick: {
    type: 'boolean',
    description: 'Skip wait for message to be delivered',
    default: false,
  },
};

const messageCommand: CommandModule = {
  command: 'message',
  describe: 'Send a test message to a remote chain',
  builder: (yargs) =>
    yargs.options({
      ...messageOptions,
      messageBody: {
        type: 'string',
        description: 'Optional Message body',
        default: 'Hello!',
      },
    }),
  handler: async (argv: any) => {
    const key: string = argv.key || process.env.HYP_KEY;
    const chainConfigPath: string = argv.chains;
    const coreArtifactsPath: string | undefined = argv.core;
    const origin: string | undefined = argv.origin;
    const destination: string | undefined = argv.destination;
    const timeoutSec: number = argv.timeout;
    const skipWaitForDelivery: boolean = argv.quick;
    const messageBody: string = argv.messageBody;
    await sendTestMessage({
      key,
      chainConfigPath,
      coreArtifactsPath,
      origin,
      destination,
      messageBody: ethers.utils.hexlify(ethers.utils.toUtf8Bytes(messageBody)),
      timeoutSec,
      skipWaitForDelivery,
    });
    process.exit(0);
  },
};

/**
 * Transfer command
 */
const transferCommand: CommandModule = {
  command: 'transfer',
  describe: 'Send a test token transfer on a warp route',
  builder: (yargs) =>
    yargs.options({
      ...messageOptions,
      router: {
        type: 'string',
        description: 'The address of the token router contract',
      },
      type: {
        type: 'string',
        description: 'Warp token type (native or collateral)',
        default: TokenType.collateral,
        choices: [TokenType.collateral, TokenType.native],
      },
      wei: {
        type: 'string',
        description: 'Amount in wei to send',
        default: 1,
      },
      recipient: {
        type: 'string',
        description: 'Token recipient address (defaults to sender)',
      },
    }),
  handler: async (argv: any) => {
    const key: string = argv.key || process.env.HYP_KEY;
    const chainConfigPath: string = argv.chains;
    const coreArtifactsPath: string | undefined = argv.core;
    const origin: string | undefined = argv.origin;
    const destination: string | undefined = argv.destination;
    const timeoutSec: number = argv.timeout;
    const routerAddress: string | undefined = argv.router;
    const tokenType: TokenType = argv.type;
    const wei: string = argv.wei;
    const recipient: string | undefined = argv.recipient;
    const skipWaitForDelivery: boolean = argv.quick;
    await sendTestTransfer({
      key,
      chainConfigPath,
      coreArtifactsPath,
      origin,
      destination,
      routerAddress,
      tokenType,
      wei,
      recipient,
      timeoutSec,
      skipWaitForDelivery,
    });
    process.exit(0);
  },
};
