import { CommandModule } from 'yargs';

import {
  Address,
  ProtocolType,
  isValidAddress,
  normalizeAddress,
} from '@hyperlane-xyz/utils';

import { CommandModuleWithContext } from '../context/types.js';
import { errorRed, log } from '../logger.js';
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
    const { multiProvider, registry } = context;

    // validate chain
    if (!multiProvider.hasChain(chain)) {
      errorRed(`❌ ${chain} is not supported by the current configuration`);
      process.exit(1);
    }

    const chainMetadata = await registry.getChainMetadata(chain);
    if (!chainMetadata) {
      errorRed(`\n❌ Unable to fetch metadata for chain ${chain}. Exiting.`);
      process.exit(1);
    }

    if (chainMetadata && chainMetadata.protocol !== ProtocolType.Ethereum) {
      errorRed(
        `\n❌ Validator pre flight check only supports EVM chains. Exiting.`,
      );
      process.exit(1);
    }

    // validate validators addresses
    const validatorList = validators.split(',');
    const invalidAddresses: Set<Address> = new Set();
    const validAddresses: Set<Address> = new Set();

    for (const address of validatorList) {
      if (isValidAddress(address)) {
        validAddresses.add(normalizeAddress(address));
      } else {
        invalidAddresses.add(address);
      }
    }

    if (invalidAddresses.size > 0) {
      errorRed(
        `❌ Invalid addresses: ${Array.from(invalidAddresses).join(', ')}`,
      );
      process.exit(1);
    }

    await checkValidatorSetup(context, chain, validAddresses);
    process.exit(0);
  },
};
