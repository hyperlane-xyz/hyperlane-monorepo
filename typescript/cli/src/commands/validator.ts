import { CommandModule } from 'yargs';

import { CommandModuleWithContext } from '../context/types.js';
import { log } from '../logger.js';
import { getValidatorAddress } from '../validator/address.js';

import {
  awsAccessKeyOption,
  awsRegionOption,
  awsSecretKeyOption,
  bucketCommandOption,
  keyIdCommandOption,
} from './options.js';

// Parent command to help configure and set up Hyperlane validators
export const validatorCommand: CommandModule = {
  command: 'validator',
  describe: 'Configure and manage Hyperlane validators',
  builder: (yargs) => yargs.command(addressCommand).demandCommand(),
  handler: () => log('Command required'),
};

// If AWS access key needed for future validator commands, move to context
const addressCommand: CommandModuleWithContext<{
  bucket: string;
  keyId: string;
}> = {
  command: 'address',
  describe: 'Get the validator address from S3 bucket or KMS key ID',
  builder: {
    'access-key': awsAccessKeyOption,
    'secret-key': awsSecretKeyOption,
    region: awsRegionOption,
    bucket: bucketCommandOption,
    'key-id': keyIdCommandOption,
  },
  handler: async ({ context, bucket, keyId }) => {
    await getValidatorAddress({ context, bucket, keyId });
    process.exit(0);
  },
};
