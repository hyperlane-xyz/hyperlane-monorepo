import {
  ChainNameToDomainId,
  hyperlaneCoreAddresses,
} from '@hyperlane-xyz/sdk';

import { S3Validator } from '../src/agents/aws/validator';
import { concurrentMap } from '../src/utils/utils';

import {
  getContextAgentConfig,
  getCoreEnvironmentConfig,
  getEnvironment,
} from './utils';

async function main() {
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment);

  const agentConfig = await getContextAgentConfig(config, 'abacus');

  const validators = Object.entries(agentConfig.validatorSets).flatMap(
    ([chain, set]) => set.validators.map((validator) => ({ chain, validator })),
  );
  const indices = await concurrentMap(
    4,
    validators,
    async ({ chain, validator }) => {
      const s3Validator = new S3Validator(
        validator.address,
        // @ts-ignore
        ChainNameToDomainId[chain],
        // @ts-ignore
        hyperlaneCoreAddresses[chain].mailbox,
        // @ts-ignore
        `https://${validator.checkpointSyncer.bucket!}.s3.${
          // @ts-ignore
          validator.checkpointSyncer.region
        }.amazonaws.com`,
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
