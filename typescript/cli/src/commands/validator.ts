import { CommandModule } from 'yargs';

import { CommandModuleWithContext } from '../context/types.js';
import { log } from '../logger.js';
import { getValidatorAddress } from '../validator/address.js';

import {
  awsAccessKeyCommandOption,
  awsBucketCommandOption,
  awsKeyIdCommandOption,
  awsRegionCommandOption,
  awsSecretKeyCommandOption,
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
  accessKey: string;
  secretKey: string;
  region: string;
  bucket: string;
  keyId: string;
}> = {
  command: 'address',
  describe: 'Get the validator address from S3 bucket or KMS key ID',
  builder: {
    'access-key': awsAccessKeyCommandOption,
    'secret-key': awsSecretKeyCommandOption,
    region: awsRegionCommandOption,
    bucket: awsBucketCommandOption,
    'key-id': awsKeyIdCommandOption,
  },
  handler: async ({ context, accessKey, secretKey, region, bucket, keyId }) => {
    await getValidatorAddress({
      context,
      accessKey,
      secretKey,
      region,
      bucket,
      keyId,
    });
    process.exit(0);
  },
};
