import { CoreConfig } from '@hyperlane-xyz/sdk';
import { objFilter, objMap, promiseObjAll } from '@hyperlane-xyz/utils';

import { InfraS3Validator } from '../../src/agents/aws/validator.js';
import { getArgs, getValidatorsByChain, withChains } from '../agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../core-utils.js';

async function main() {
  const { environment, chains } = await withChains(getArgs()).argv;
  const config = getEnvironmentConfig(environment);
  const { core } = await getHyperlaneCore(environment);

  // Filter the config map to only check the given networks if supplied
  const filteredConfig =
    chains && chains.length > 0
      ? objFilter(config.core, (chain, _): _ is CoreConfig =>
          (chains ?? []).includes(chain),
        )
      : config.core;

  await promiseObjAll(
    objMap(getValidatorsByChain(filteredConfig), async (chain, set) => {
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
            const metrics =
              await prospectiveValidator.compare(controlValidator);
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
