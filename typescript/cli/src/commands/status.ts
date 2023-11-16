import { CommandModule } from 'yargs';

import { checkMessageStatus } from '../status/message.js';

import { chainsCommandOption, coreArtifactsOption } from './options.js';

export const statusCommand: CommandModule = {
  command: 'status',
  describe: 'Check status of a message',
  builder: (yargs) =>
    yargs.options({
      chains: chainsCommandOption,
      core: coreArtifactsOption,
      id: {
        type: 'string',
        description: 'Message ID',
        demandOption: true,
      },
      destination: {
        type: 'string',
        description: 'Destination chain name',
        demandOption: true,
      },
    }),
  handler: async (argv: any) => {
    const chainConfigPath: string = argv.chains;
    const coreArtifactsPath: string = argv.core;
    const messageId: string = argv.id;
    const destination: string = argv.destination;
    await checkMessageStatus({
      chainConfigPath,
      coreArtifactsPath,
      messageId,
      destination,
    });
    process.exit(0);
  },
};
