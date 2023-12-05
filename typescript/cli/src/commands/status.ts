import { CommandModule } from 'yargs';

import { checkMessageStatus } from '../status/message.js';

import { chainsCommandOption, coreArtifactsOption } from './options.js';

export const statusCommand: CommandModule = {
  command: 'status',
  describe: 'Check status of a message',
  builder: (yargs) =>
    yargs.options({
      id: {
        type: 'string',
        description: 'Message ID',
      },
      destination: {
        type: 'string',
        description: 'Destination chain name',
      },
      chains: chainsCommandOption,
      core: coreArtifactsOption,
    }),
  handler: async (argv: any) => {
    const chainConfigPath: string = argv.chains;
    const coreArtifactsPath: string | undefined = argv.core;
    const messageId: string | undefined = argv.id;
    const destination: string | undefined = argv.destination;
    await checkMessageStatus({
      chainConfigPath,
      coreArtifactsPath,
      messageId,
      destination,
    });
    process.exit(0);
  },
};
