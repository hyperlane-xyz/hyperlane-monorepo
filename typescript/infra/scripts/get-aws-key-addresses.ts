import { KEY_ROLE_ENUM, KEY_ROLES } from '../src/agents';
import { isValidatorKey } from '../src/agents/agent';
import { AgentAwsUser, ValidatorAgentAwsUser } from '../src/agents/aws';
import { AgentConfig } from '../src/config';
import { getAgentConfig, getEnvironment, getDomainNames } from './utils';
import { CheckpointSyncerType } from '../src/config/agent';
import { ChainName } from '@abacus-network/sdk';

async function main() {
  const environment = await getEnvironment();
  const agentConfig = await getAgentConfig(environment);
  const domainNames = await getDomainNames(environment);

  const keyInfos = await Promise.all(
    KEY_ROLES.flatMap((role) => {
      if (isValidatorKey(role)) {
        // For each chainName, create validatorCount keys
        return domainNames.flatMap((chainName) =>
          [
            ...Array(
              agentConfig.validatorSets[chainName].validators.length,
            ).keys(),
          ].map((index) => getAddress(agentConfig, role, chainName, index)),
        );
      } else {
        // Chain name doesnt matter for non attestation keys
        return [getAddress(agentConfig, role, domainNames[0])];
      }
    }),
  );
  console.log('Keys:', JSON.stringify(keyInfos, null, 2));
}

async function getAddress(
  agentConfig: AgentConfig<any>,
  role: KEY_ROLE_ENUM,
  chain: ChainName,
  index?: number,
) {
  let user: AgentAwsUser<any>;

  if (role === KEY_ROLE_ENUM.Validator) {
    if (index === undefined) {
      throw Error('Expected index');
    }
    const checkpointSyncer =
      agentConfig.validatorSets[chain].validators[index].checkpointSyncer;
    if (checkpointSyncer.type !== CheckpointSyncerType.S3) {
      throw Error('Expected S3 checkpoint syncer for validator with AWS keys');
    }
    user = new ValidatorAgentAwsUser(
      agentConfig.environment,
      chain,
      index!,
      checkpointSyncer.region,
      checkpointSyncer.bucket,
    );
  } else {
    user = new AgentAwsUser(
      agentConfig.environment,
      chain,
      role,
      agentConfig.aws!.region,
    );
  }
  const key = user.key(agentConfig);
  let address = '';
  try {
    await key.fetch();
    address = key.address;
  } catch (err) {
    console.error(`Error getting key ${key.identifier}`, err);
  }
  return {
    alias: key.identifier,
    address,
  };
}

main().catch(console.error);
