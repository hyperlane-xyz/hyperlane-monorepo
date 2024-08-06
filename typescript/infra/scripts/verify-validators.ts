import { objMap, promiseObjAll } from '@hyperlane-xyz/utils';

import { InfraS3Validator } from '../src/agents/aws/validator.js';

import { getArgs, getValidatorsByChain } from './agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from './core-utils.js';

async function main() {
  const { environment } = await getArgs().argv;
  const config = getEnvironmentConfig(environment);
  const { core } = await getHyperlaneCore(environment);

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
          return InfraS3Validator.fromStorageLocation(storageLocations[i][0]);
        }),
      );
      const controlValidator = validators[0];
      await Promise.all(
        validators.slice(1).map(async (prospectiveValidator) => {
          const address = prospectiveValidator.address;
          const bucket = prospectiveValidator.s3Bucket;
          try {
            const metrics = await prospectiveValidator.compare(
              controlValidator,
            );
            console.log(
              `${chain} ${bucket} validators against control ${controlValidator.s3Bucket}`,
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
