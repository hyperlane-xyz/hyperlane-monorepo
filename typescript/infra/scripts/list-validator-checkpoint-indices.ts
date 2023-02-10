import { HyperlaneCore } from '@hyperlane-xyz/sdk';

import { S3Validator } from '../src/agents/aws/validator';
import { deployEnvToSdkEnv } from '../src/config/environment';
import { concurrentMap } from '../src/utils/utils';

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

  const validators = Object.entries(config.core).flatMap(([chain, set]) =>
    set.multisigIsm.validators.map((validator) => ({ chain, validator })),
  );

  const indices = await concurrentMap(
    4,
    validators,
    async ({ chain, validator }) => {
      // @ts-ignore Not sure why I need to do this..
      const validatorAnnounce = core.getContracts(chain).validatorAnnounce;
      const storageLocations =
        await validatorAnnounce.getAnnouncedStorageLocations([validator]);
      // Only use the latest announcement for now
      let index = null;
      let identifier = validator;
      if (storageLocations.length == 1 && storageLocations[0].length == 1) {
        try {
          const s3Validator = await S3Validator.fromStorageLocation(
            storageLocations[0][0],
          );
          identifier = storageLocations[0][0];
          index = await s3Validator.getLatestCheckpointIndex();
        } catch (e) {
          console.error(e);
        }
      }
      return {
        chain,
        identifier,
        index,
      };
    },
  );

  console.table(indices, ['chain', 'index', 'identifier']);
}

main().catch(console.error);
