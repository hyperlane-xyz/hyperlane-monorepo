import { ChainName } from '@abacus-network/sdk';
import { utils } from '@abacus-network/utils';

import { Contexts } from '../../config/contexts';
import { AgentConfig, DeployEnvironment } from '../config';
import { ChainAgentConfig, CheckpointSyncerType } from '../config/agent';
import { fetchGCPSecret } from '../utils/gcloud';
import { HelmCommand, helmifyValues } from '../utils/helm';
import { execCmd } from '../utils/utils';

import { keyIdentifier } from './agent';
import { AgentAwsUser, ValidatorAgentAwsUser } from './aws';
import { AgentAwsKey } from './aws/key';
import { AgentGCPKey } from './gcp';
import { fetchKeysForChain } from './key-utils';
import { KEY_ROLE_ENUM } from './roles';

async function helmValuesForChain<Chain extends ChainName>(
  chainName: Chain,
  agentConfig: AgentConfig<Chain>,
) {
  const chainAgentConfig = new ChainAgentConfig(agentConfig, chainName);

  return {
    image: {
      repository: agentConfig.docker.repo,
      tag: agentConfig.docker.tag,
    },
    abacus: {
      runEnv: agentConfig.runEnv,
      context: agentConfig.context,
      baseConfig: `${chainName}_config.json`,
      outboxChain: {
        name: chainName,
      },
      aws: !!agentConfig.aws,
      inboxChains: agentConfig.environmentChainNames
        .filter((name) => name !== chainName)
        .map((remoteChainName) => {
          return {
            name: remoteChainName,
            disabled: !agentConfig.contextChainNames.includes(remoteChainName),
          };
        }),
      validator: {
        enabled: chainAgentConfig.validatorEnabled,
        configs: await chainAgentConfig.validatorConfigs(),
      },
      relayer: {
        enabled: chainAgentConfig.relayerEnabled,
        aws: await chainAgentConfig.relayerRequiresAwsCredentials(),
        signers: await chainAgentConfig.relayerSigners(),
        config: chainAgentConfig.relayerConfig,
      },
      kathy: {
        enabled: chainAgentConfig.kathyEnabled,
        aws: chainAgentConfig.kathyRequiresAwsCredentials,
        signers: await chainAgentConfig.kathySigners(),
        config: chainAgentConfig.kathyConfig,
      },
    },
  };
}

export async function getAgentEnvVars<Chain extends ChainName>(
  outboxChainName: Chain,
  role: KEY_ROLE_ENUM,
  agentConfig: AgentConfig<Chain>,
  index?: number,
) {
  const chainNames = agentConfig.contextChainNames;
  if (role === KEY_ROLE_ENUM.Validator && index === undefined) {
    throw Error('Expected index for validator role');
  }

  const valueDict = await helmValuesForChain(outboxChainName, agentConfig);
  let envVars: string[] = [];
  const rpcEndpoints = await getSecretRpcEndpoints(agentConfig);
  envVars.push(
    `ABC_BASE_OUTBOX_CONNECTION_URL=${rpcEndpoints[outboxChainName]}`,
  );
  valueDict.abacus.inboxChains.forEach((inboxChain: any) => {
    envVars.push(
      `ABC_BASE_INBOXES_${inboxChain.name.toUpperCase()}_CONNECTION_URL=${
        rpcEndpoints[inboxChain.name]
      }`,
    );
  });

  // Base vars from config map
  envVars.push(`BASE_CONFIG=${valueDict.abacus.baseConfig}`);
  envVars.push(`RUN_ENV=${agentConfig.runEnv}`);
  envVars.push(`ABC_BASE_METRICS=9090`);
  envVars.push(`ABC_BASE_TRACING_LEVEL=info`);
  envVars.push(
    `ABC_BASE_DB=/tmp/${agentConfig.environment}-${role}-${outboxChainName}${
      role === KEY_ROLE_ENUM.Validator ? `-${index}` : ''
    }-db`,
  );

  // GCP keys
  if (!agentConfig.aws) {
    const gcpKeys = (await fetchKeysForChain(
      agentConfig,
      outboxChainName,
    )) as Record<string, AgentGCPKey>;

    const keyId = keyIdentifier(
      agentConfig.environment,
      agentConfig.context,
      role,
      outboxChainName,
      index,
    );

    // Only the relayer or kathy need to sign txs
    if (role === KEY_ROLE_ENUM.Relayer || role === KEY_ROLE_ENUM.Kathy) {
      chainNames.forEach((name) => {
        envVars.push(
          `ABC_BASE_SIGNERS_${name.toUpperCase()}_KEY=${utils.strip0x(
            gcpKeys[keyId].privateKey,
          )}`,
        );
        envVars.push(`ABC_BASE_SIGNERS_${name.toUpperCase()}_TYPE=hexKey`);
      });
    } else if (role === KEY_ROLE_ENUM.Validator) {
      const privateKey = gcpKeys[keyId].privateKey;

      envVars.push(
        `ABC_VALIDATOR_VALIDATOR_KEY=${utils.strip0x(privateKey)}`,
        `ABC_VALIDATOR_VALIDATOR_TYPE=hexKey`,
      );
    }
  } else {
    // AWS keys

    let user: AgentAwsUser<Chain>;

    if (role === KEY_ROLE_ENUM.Validator) {
      const checkpointSyncer =
        agentConfig.validatorSets[outboxChainName].validators[index!]
          .checkpointSyncer;
      if (checkpointSyncer.type !== CheckpointSyncerType.S3) {
        throw Error(
          'Expected S3 checkpoint syncer for validator with AWS keys',
        );
      }
      user = new ValidatorAgentAwsUser(
        agentConfig.environment,
        agentConfig.context,
        outboxChainName,
        index!,
        checkpointSyncer.region,
        checkpointSyncer.bucket,
      );
    } else {
      user = new AgentAwsUser(
        agentConfig.environment,
        agentConfig.context,
        role,
        agentConfig.aws!.region,
        outboxChainName,
      );
    }

    const accessKeys = await user.getAccessKeys();

    envVars.push(`AWS_ACCESS_KEY_ID=${accessKeys.accessKeyId}`);
    envVars.push(`AWS_SECRET_ACCESS_KEY=${accessKeys.secretAccessKey}`);

    // Only the relayer or kathy need to sign txs
    if (role === KEY_ROLE_ENUM.Relayer || role === KEY_ROLE_ENUM.Kathy) {
      chainNames.forEach((chainName) => {
        const key = new AgentAwsKey(agentConfig, role, outboxChainName);
        envVars = envVars.concat(
          configEnvVars(
            key.keyConfig,
            'BASE',
            `SIGNERS_${chainName.toUpperCase()}_`,
          ),
        );
      });
    }
  }

  switch (role) {
    case KEY_ROLE_ENUM.Validator:
      if (valueDict.abacus.validator.configs) {
        envVars = envVars.concat(
          configEnvVars(
            valueDict.abacus.validator.configs[index!],
            KEY_ROLE_ENUM.Validator,
          ),
        );
      }
      break;
    case KEY_ROLE_ENUM.Relayer:
      if (valueDict.abacus.relayer.config) {
        envVars = envVars.concat(
          configEnvVars(valueDict.abacus.relayer.config, KEY_ROLE_ENUM.Relayer),
        );
      }
      break;
    case KEY_ROLE_ENUM.Kathy:
      if (valueDict.abacus.kathy.config) {
        envVars = envVars.concat(
          configEnvVars(valueDict.abacus.kathy.config, KEY_ROLE_ENUM.Kathy),
        );
      }
      break;
  }

  return envVars;
}

// Recursively converts a config object into environment variables than can
// be parsed by rust. For example, a config of { foo: { bar: { baz: 420 }, boo: 421 } } will
// be: ABC_FOO_BAR_BAZ=420 and ABC_FOO_BOO=421
function configEnvVars(
  config: Record<string, any>,
  role: string,
  key_name_prefix = '',
) {
  let envVars: string[] = [];
  for (const key of Object.keys(config)) {
    const value = config[key];
    if (typeof value === 'object') {
      envVars = [
        ...envVars,
        ...configEnvVars(
          value,
          role,
          `${key_name_prefix}${key.toUpperCase()}_`,
        ),
      ];
    } else {
      envVars.push(
        `ABC_${role.toUpperCase()}_${key_name_prefix}${key.toUpperCase()}=${
          config[key]
        }`,
      );
    }
  }
  return envVars;
}

export async function getSecretAwsCredentials<Chain extends ChainName>(
  agentConfig: AgentConfig<Chain>,
) {
  return {
    accessKeyId: await fetchGCPSecret(
      `${agentConfig.runEnv}-aws-access-key-id`,
      false,
    ),
    secretAccessKey: await fetchGCPSecret(
      `${agentConfig.runEnv}-aws-secret-access-key`,
      false,
    ),
  };
}

export async function getSecretRpcEndpoint(
  environment: string,
  chainName: ChainName,
  quorum = false,
) {
  return fetchGCPSecret(
    `${environment}-rpc-endpoint${quorum ? 's' : ''}-${chainName}`,
    quorum,
  );
}

export async function getSecretDeployerKey(
  environment: DeployEnvironment,
  context: Contexts,
  chainName: ChainName,
) {
  const key = new AgentGCPKey(
    environment,
    context,
    KEY_ROLE_ENUM.Deployer,
    chainName,
  );
  await key.fetch();
  return key.privateKey;
}

async function getSecretRpcEndpoints<Chain extends ChainName>(
  agentConfig: AgentConfig<Chain>,
  quorum = false,
) {
  const environment = agentConfig.runEnv;
  return Object.fromEntries(
    agentConfig.contextChainNames.map((chainName) => [
      chainName,
      getSecretRpcEndpoint(environment, chainName, quorum),
    ]),
  );
}

export async function runAgentHelmCommand<Chain extends ChainName>(
  action: HelmCommand,
  agentConfig: AgentConfig<Chain>,
  outboxChainName: Chain,
) {
  const valueDict = await helmValuesForChain(outboxChainName, agentConfig);
  const values = helmifyValues(valueDict);

  const extraPipe =
    action === HelmCommand.UpgradeDiff
      ? ` | kubectl diff -n ${agentConfig.namespace} --field-manager="Go-http-client" -f - || true`
      : '';

  return execCmd(
    `helm ${action} ${getHelmReleaseName(
      outboxChainName,
      agentConfig,
    )} ../../rust/helm/abacus-agent/ --create-namespace --namespace ${
      agentConfig.namespace
    } ${values.join(' ')} ${extraPipe}`,
    {},
    false,
    true,
  );
}

function getHelmReleaseName<Chain extends ChainName>(
  outboxChainName: Chain,
  agentConfig: AgentConfig<Chain>,
): string {
  // For backward compatibility reasons, don't include the context
  // in the name of the helm release if the context is the default "abacus"
  if (agentConfig.context === 'abacus') {
    return outboxChainName;
  }
  return `${outboxChainName}-${agentConfig.context}`;
}

export async function getCurrentKubernetesContext(): Promise<string> {
  const [stdout] = await execCmd(
    `kubectl config current-context`,
    { encoding: 'utf8' },
    false,
    false,
  );
  return stdout.trimEnd();
}
