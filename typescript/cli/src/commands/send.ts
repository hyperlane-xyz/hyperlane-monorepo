import { CommandModule, Options } from 'yargs';

import { log } from '../logger.js';
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
  chains: chainsCommandOption,
  core: coreArtifactsOption,
  origin: {
    type: 'string',
    description: 'Origin chain to send message from',
    demandOption: true,
  },
  destination: {
    type: 'string',
    description: 'Destination chain to send message to',
    demandOption: true,
  },
  timeout: {
    type: 'number',
    description: 'Timeout in seconds',
    default: 5 * 60,
  },
};

const messageCommand: CommandModule = {
  command: 'message',
  describe: 'Send a test message to a remote chain',
  builder: (yargs) => yargs.options(messageOptions),
  handler: async (argv: any) => {
    const key: string = argv.key || process.env.HYP_KEY;
    const chainConfigPath: string = argv.chains;
    const coreArtifactsPath: string = argv.core;
    const origin: string = argv.origin;
    const destination: string = argv.destination;
    const timeout: number = argv.timeout;
    await sendTestMessage({
      key,
      chainConfigPath,
      coreArtifactsPath,
      origin,
      destination,
      timeout,
    });
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
        demandOption: true,
      },
      wei: {
        type: 'number',
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
    const coreArtifactsPath: string = argv.core;
    const origin: string = argv.origin;
    const destination: string = argv.destination;
    const timeout: number = argv.timeout;
    const routerAddress: string = argv.router;
    const wei: number = argv.wei;
    const recipient: string | undefined = argv.recipient;

    await sendTestTransfer({
      key,
      chainConfigPath,
      coreArtifactsPath,
      origin,
      destination,
      routerAddress,
      wei,
      recipient,
      timeout,
    });
  },
};
