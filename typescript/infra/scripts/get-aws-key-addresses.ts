import { KEY_ROLE_ENUM, KEY_ROLES } from '../src/agents';
import { AgentAwsUser, ValidatorAgentAwsUser } from '../src/agents/aws';
import { AgentConfig } from '../src/config';
import { getAgentConfig, getEnvironment, getDomainNames } from './utils';
import { CheckpointSyncerType } from '../src/config/agent';
import { ChainName } from '@abacus-network/sdk';
import { RelayerAgentAwsUser } from '../src/agents/aws/relayer-user';

async function main() {
  const environment = await getEnvironment();
  const agentConfig = await getAgentConfig(environment);
  const domainNames = await getDomainNames(environment);

  const keyInfos = await Promise.all(
    KEY_ROLES.flatMap((role) => {
      switch (role) {
        case KEY_ROLE_ENUM.Validator:
          return domainNames.flatMap((chainName) =>
            [
              ...Array(
                agentConfig.validatorSets[chainName].validators.length,
              ).keys(),
            ].flatMap((index) =>
              getAddresses(agentConfig, role, chainName, index),
            ),
          );
        case KEY_ROLE_ENUM.Relayer:
          return domainNames.flatMap((chainName) =>
            getAddresses(agentConfig, role, chainName),
          );
        default:
          // Chain name doesnt matter for other keys
          return getAddresses(agentConfig, role, domainNames[0]);
      }
    }),
  );
  console.log('Keys:', JSON.stringify(keyInfos, null, 2));
}

async function getAddresses(
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
  } else if (role === KEY_ROLE_ENUM.Relayer) {
    user = new RelayerAgentAwsUser(
      agentConfig.environment,
      chain,
      agentConfig.aws!.region,
    );
  } else {
    user = new AgentAwsUser(
      agentConfig.environment,
      chain,
      role,
      agentConfig.aws!.region,
    );
  }
  const keys = user.keys(agentConfig);
  return Promise.all(
    keys.map(async (key) => {
      let address = '';
      try {
        await key.fetch();
        address = key.address;
      } catch (err) {
        // ignore error
      }
      return {
        alias: key.identifier,
        address,
      };
    }),
  );
}

main().catch(console.error);
