import { CommandModule } from 'yargs';

import { CommandModuleWithContext } from '../context/types.js';
import { log } from '../logger.js';
import { getValidatorAddress } from '../validator/address.js';

// Parent command to help configure and set up Hyperlane validators
export const validatorCommand: CommandModule = {
  command: 'validator',
  describe: 'Configure and manage Hyperlane validators',
  builder: (yargs) => yargs.command(addressCommand).demandCommand(),
  handler: () => log('Command required'),
};

const addressCommand: CommandModuleWithContext<{
  bucket: string;
  keyId: string;
}> = {
  command: 'address',
  describe: 'Get the validator address from S3 bucket or KMS key ID',
  builder: {
    bucket: {
      type: 'string',
      describe:
        'AWS S3 bucket containing validator signatures and announcement',
    },
    'key-id': {
      type: 'string',
      describe: 'Key ID from AWS KMS',
    },
  },
  handler: async ({ context, bucket, keyId }) => {
    await getValidatorAddress({ context, bucket, keyId });
    process.exit(0);
  },
};
