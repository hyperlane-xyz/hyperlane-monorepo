import { ethers } from 'ethers';

import { ChainNameToDomainId, objMap } from '@hyperlane-xyz/sdk';

import { S3Validator } from '../src/agents/aws/validator';
import { CheckpointSyncerType } from '../src/config/agent';

import { getContext, getCoreEnvironmentConfig, getEnvironment } from './utils';

async function main() {
  const environment = await getEnvironment();
  const coreConfig = getCoreEnvironmentConfig(environment);
  const context = await getContext();
  const validatorSets = coreConfig.agents[context]?.validatorSets!;
  objMap(validatorSets, async (chain, validatorSet) => {
    const domainId = ChainNameToDomainId[chain];
    const controlCheckpointSyncer = validatorSet.validators[0].checkpointSyncer;
    if (controlCheckpointSyncer.type == CheckpointSyncerType.S3) {
    }
    const validators = validatorSet.validators.map((validator) => {
      const checkpointSyncer = validator.checkpointSyncer;
      if (checkpointSyncer.type == CheckpointSyncerType.S3) {
        return new S3Validator(
          ethers.constants.AddressZero,
          domainId,
          checkpointSyncer.bucket,
          checkpointSyncer.region,
        );
      }
      throw new Error('Cannot check non-s3 validator type');
    });
    const controlValidator = validators[0];
    for (let i = 1; i < validators.length; i++) {
      const prospectiveValidator = validators[i];
      const metrics = await prospectiveValidator.compare(controlValidator);
      console.log(JSON.stringify(metrics, null, 2));
    }
  });
}

main().catch(console.error);
