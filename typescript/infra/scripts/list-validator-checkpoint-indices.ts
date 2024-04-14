import { HyperlaneCore } from '@hyperlane-xyz/sdk';
import { concurrentMap } from '@hyperlane-xyz/utils';

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

  const validators = Object.entries(getValidatorsByChain(config.core)).flatMap(
    ([chain, set]) => [...set].map((validator) => ({ chain, validator })),
  );

  const indices = await concurrentMap(
    4,
    validators,
    async ({ chain, validator }) => {
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
