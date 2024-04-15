import { CommandModule } from 'yargs';

import { checkMessageStatus } from '../status/message.js';

import { messageOptions } from './send.js';

export const statusCommand: CommandModule = {
  command: 'status',
  describe: 'Check status of a message',
  builder: (yargs) =>
    yargs.options({
      ...messageOptions,
      id: {
        type: 'string',
        description: 'Message ID',
      },
    }),
  handler: async (argv: any) => {
    const chainConfigPath: string = argv.chains;
    const coreArtifactsPath: string | undefined = argv.core;
    const messageId: string | undefined = argv.id;
    const destination: string | undefined = argv.destination;
    const origin: string | undefined = argv.origin;
    const selfRelay: boolean = argv['self-relay'];
    const key: string | undefined = argv.key;

    await checkMessageStatus({
      chainConfigPath,
      coreArtifactsPath,
      messageId,
      destination,
      origin,
      selfRelay,
      key,
    });
    process.exit(0);
  },
};
