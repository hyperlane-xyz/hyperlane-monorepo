import { HyperlaneCore } from '@hyperlane-xyz/sdk';
import { objMap, promiseObjAll } from '@hyperlane-xyz/utils';

import { S3Validator } from '../src/agents/aws/validator.js';
import { deployEnvToSdkEnv } from '../src/config/environment.js';

import { getArgs, getValidatorsByChain } from './agent-utils.js';
import { getEnvironmentConfig } from './core-utils.js';

async function main() {
  const { environment } = await getArgs().argv;
  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();
  const core = HyperlaneCore.fromEnvironment(
    deployEnvToSdkEnv[environment],
    multiProvider,
  );

  await promiseObjAll(
    objMap(getValidatorsByChain(config.core), async (chain, set) => {
      const validatorAnnounce = core.getContracts(chain).validatorAnnounce;
      const storageLocations =
        await validatorAnnounce.getAnnouncedStorageLocations([...set]);
      const validators = await Promise.all(
        [...set].map((_validator, i) => {
          // Only use the latest announcement for now
          if (storageLocations[i].length != 1) {
            throw new Error('Only support single announcement');
          }
          return S3Validator.fromStorageLocation(storageLocations[i][0]);
        }),
      );
      const controlValidator = validators[0];
      await Promise.all(
        validators.slice(1).map(async (prospectiveValidator) => {
          const address = prospectiveValidator.address;
          const bucket = prospectiveValidator.s3Bucket.bucket;
          try {
            const metrics = await prospectiveValidator.compare(
              controlValidator,
            );
            console.log(
              `${chain} ${bucket} validators against control ${controlValidator.s3Bucket.bucket}`,
            );
            console.table(metrics);
          } catch (error) {
            console.error(`Comparing validator ${address}@${bucket} failed:`);
            throw error;
          }
        }),
      );
    }),
  );
}

main().catch(console.error);
