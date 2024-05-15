import { CommandModule } from 'yargs';

import { CommandModuleWithContext } from '../context/types.js';
import { log } from '../logger.js';
import { getAddressFromBucket } from '../validator/address.js';

// Parent command to eventually setup Hyperlane validators with
export const validatorCommand: CommandModule = {
  command: 'validator',
  describe: 'Configure and set up Hyperlane validators',
  builder: (yargs) => yargs.command(addressCommand).demandCommand(),
  handler: () => log('Command required'),
};

const addressCommand: CommandModuleWithContext<{
  bucket: string;
}> = {
  command: 'address',
  describe: 'Get the address of a validator',
  builder: {
    bucket: {
      type: 'string',
      describe:
        'AWS S3 bucket containing validator signatures and announcement',
    },
  },
  handler: async ({ context, bucket }) => {
    await getAddressFromBucket({ context, bucket });
    process.exit(0);
  },
};
