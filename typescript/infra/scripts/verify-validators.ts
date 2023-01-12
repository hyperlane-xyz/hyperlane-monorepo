import {
  ChainNameToDomainId,
  HyperlaneCore,
  hyperlaneCoreAddresses,
  objMap,
} from '@hyperlane-xyz/sdk';

import { CheckpointStatus, S3Validator } from '../src/agents/aws/validator';
import { deployEnvToSdkEnv } from '../src/config/environment';

import { getCoreEnvironmentConfig, getEnvironment } from './utils';

async function main() {
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();
  // environments union doesn't work well with typescript
  const core = HyperlaneCore.fromEnvironment(
    deployEnvToSdkEnv[environment],
    multiProvider as any,
  );

  objMap(config.core, async (chain, coreConfig) => {
    const domainId = ChainNameToDomainId[chain];
    const mailbox = hyperlaneCoreAddresses[chain].mailbox;
    // @ts-ignore Not sure why I need to do this..
    const validatorAnnounce = core.getContracts(chain).validatorAnnounce;
    const storageLocations =
      await validatorAnnounce.getAnnouncedStorageLocations(
        coreConfig.multisigIsm.validators,
      );
    const validators = coreConfig.multisigIsm.validators.map((validator, i) => {
      // Only use the latest announcement for now
      if (storageLocations[i].length != 1) {
        throw new Error('Only support single announcement');
      }
      return S3Validator.fromStorageLocation(
        validator,
        domainId,
        mailbox,
        storageLocations[i][0],
      );
    });
    const controlValidator = validators[0];
    for (let i = 1; i < validators.length; i++) {
      const prospectiveValidator = validators[i];
      const metrics = await prospectiveValidator.compare(controlValidator);
      const valid =
        metrics.filter((metric) => metric.status !== CheckpointStatus.VALID)
          .length === 0;
      if (!valid) {
        console.log(
          `${prospectiveValidator.address} has >=1 non-valid checkpoints for ${chain}`,
        );
        console.log(JSON.stringify(metrics, null, 2));
      } else {
        console.log(
          `${prospectiveValidator.address} has valid checkpoints for ${chain}`,
        );
      }
    }
  });
}

main().catch(console.error);
