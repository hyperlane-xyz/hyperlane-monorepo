import { KEY_ROLE_ENUM, KEY_ROLES } from '../src/agents';
import { AgentAwsUser, ValidatorAgentAwsUser } from '../src/agents/aws';
import { AgentConfig } from '../src/config';
import { getAgentConfig, getEnvironment, getDomainNames } from './utils';
import { CheckpointSyncerType } from '../src/config/agent';
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
            ].flatMap((index) => {
              const checkpointSyncer =
                agentConfig.validatorSets[chainName].validators[index]
                  .checkpointSyncer;
              if (checkpointSyncer.type !== CheckpointSyncerType.S3) {
                throw Error(
                  'Expected S3 checkpoint syncer for validator with AWS keys',
                );
              }
              const user = new ValidatorAgentAwsUser(
                agentConfig.environment,
                chainName,
                index,
                checkpointSyncer.region,
                checkpointSyncer.bucket,
              );
              return getAddresses(agentConfig, user);
            }),
          );
        case KEY_ROLE_ENUM.Relayer:
          return domainNames.flatMap((chainName) => {
            const user = new RelayerAgentAwsUser(
              agentConfig.environment,
              chainName,
              agentConfig.aws!.region,
            );
            return getAddresses(agentConfig, user);
          });
        default:
          // Chain name doesnt matter for other keys
          const user = new AgentAwsUser(
            agentConfig.environment,
            domainNames[0],
            role,
            agentConfig.aws!.region,
          );
          return getAddresses(agentConfig, user);
      }
    }),
  );
  console.log('Keys:', JSON.stringify(keyInfos, null, 2));
}

async function getAddresses(
  agentConfig: AgentConfig<any>,
  user: AgentAwsUser<any>,
) {
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
