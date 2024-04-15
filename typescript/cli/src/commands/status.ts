import { CommandModule } from 'yargs';

import { checkMessageStatus } from '../status/message.js';
import { ENV } from '../utils/env.js';

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
    const selfRelay: boolean = argv.selfrelay;
    const key: string | undefined = argv.key || ENV.HYP_KEY;

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
