import { CommandModule } from 'yargs';

import {
  Address,
  isValidAddress,
  normalizeAddress,
} from '@hyperlane-xyz/utils';

import { CommandModuleWithContext } from '../context/types.js';
import { log, logRed } from '../logger.js';
import { getValidatorAddress } from '../validator/address.js';
import { checkValidatorSetup } from '../validator/preFlightCheck.js';

import {
  awsAccessKeyCommandOption,
  awsBucketCommandOption,
  awsKeyIdCommandOption,
  awsRegionCommandOption,
  awsSecretKeyCommandOption,
  chainCommandOption,
  makeOptionRequired,
  validatorCommandOption,
} from './options.js';

// Parent command to help configure and set up Hyperlane validators
export const validatorCommand: CommandModule = {
  command: 'validator',
  describe: 'Configure and manage Hyperlane validators',
  builder: (yargs) =>
    yargs
      .command(addressCommand)
      .command(preFlightCheckCommand)
      .demandCommand(),
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

const preFlightCheckCommand: CommandModuleWithContext<{
  chain: string;
  validators: string;
}> = {
  command: 'preflightCheck',
  describe: 'Check the validator has announced correctly for a given chain',
  builder: {
    chain: makeOptionRequired(chainCommandOption),
    validators: validatorCommandOption,
  },
  handler: async ({ context, chain, validators }) => {
    const { multiProvider } = context;

    // validate chain
    if (!multiProvider.hasChain(chain)) {
      logRed(`Chain ${chain} is not supported by the current configuration`);
      process.exit(1);
    }

    // validate validators addresses
    // TODO: how do we handle non EVM addresses
    // TODO: consider using set
    const validatorList = validators.split(',');
    const invalidAddresses: string[] = [];
    const validAddresses: Address[] = [];

    for (const address of validatorList) {
      if (isValidAddress(address)) {
        validAddresses.push(normalizeAddress(address));
      } else {
        invalidAddresses.push(address);
      }
    }

    if (invalidAddresses.length > 0) {
      logRed(`Invalid addresses: ${invalidAddresses.join(', ')}`);
      process.exit(1);
    }

    await checkValidatorSetup(context, chain, validAddresses);
    process.exit(0);
  },
};
