import { HyperlaneCore, objMap } from '@hyperlane-xyz/sdk';

import { CheckpointStatus, S3Validator } from '../src/agents/aws/validator';
import { deployEnvToSdkEnv } from '../src/config/environment';

import { getCoreEnvironmentConfig, getEnvironment } from './utils';

async function main() {
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();
  const core = HyperlaneCore.fromEnvironment(
    deployEnvToSdkEnv[environment],
    multiProvider,
  );

  objMap(config.core, async (chain, coreConfig) => {
    const validatorAnnounce = core.getContracts(chain).validatorAnnounce;
    const storageLocations =
      await validatorAnnounce.getAnnouncedStorageLocations(
        coreConfig.multisigIsm.validators,
      );
    const validators = await Promise.all(
      coreConfig.multisigIsm.validators.map((validator, i) => {
        // Only use the latest announcement for now
        if (storageLocations[i].length != 1) {
          throw new Error('Only support single announcement');
        }
        return S3Validator.fromStorageLocation(storageLocations[i][0]);
      }),
    );
    const controlValidator = validators[0];
    for (let i = 1; i < validators.length; i++) {
      const prospectiveValidator = validators[i];
      const address = prospectiveValidator.address;
      const bucket = prospectiveValidator.s3Bucket.bucket;
      try {
        const metrics = await prospectiveValidator.compare(controlValidator);
        const valid =
          metrics.filter((metric) => metric.status !== CheckpointStatus.VALID)
            .length === 0;
        if (!valid) {
          console.log(
            `${address}@${bucket} has >=1 non-valid checkpoints for ${chain}`,
          );
          console.log(JSON.stringify(metrics, null, 2));
        } else {
          console.log(
            `${address}@${bucket} has valid checkpoints for ${chain}`,
          );
        }
      } catch (error) {
        console.error(`Comparing validator ${address}@${bucket} failed:`);
        console.error(error);
        throw error;
      }
    }
  });
}

main().catch(console.error);
