import {
  ChainNameToDomainId,
  HyperlaneCore,
  hyperlaneCoreAddresses,
} from '@hyperlane-xyz/sdk';

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
      const s3Validator = new S3Validator(
        validator,
        ChainNameToDomainId[chain],
        hyperlaneCoreAddresses[chain].mailbox,
        validator.checkpointSyncer.bucket,
        validator.checkpointSyncer.region,
      );

      return {
        chain,
        name: validator.name,
        address: validator.address,
        index: await s3Validator.getLatestCheckpointIndex(),
      };
    },
  );

  console.table(indices, ['chain', 'index', 'name', 'address']);
}

main().catch(console.error);
