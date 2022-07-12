import { ChainName } from '@abacus-network/sdk';

import { AgentConfig, DeployEnvironment } from '../config';
import { ChainAgentConfig, CheckpointSyncerType } from '../config/agent';
import { fetchGCPSecret } from '../utils/gcloud';
import { HelmCommand, helmifyValues } from '../utils/helm';
import { ensure0x, execCmd, strip0x } from '../utils/utils';
import { rm, writeFile } from 'fs/promises';

import { keyIdentifier } from './agent';
import { AgentAwsUser, ValidatorAgentAwsUser } from './aws';
import { AgentAwsKey } from './aws/key';
import { AgentGCPKey } from './gcp';
import { fetchKeysForChain } from './key-utils';
import { KEY_ROLES, KEY_ROLE_ENUM } from './roles';

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
      baseConfig: `${chainName}_config.json`,
      outboxChain: {
        name: chainName,
      },
      aws: !!agentConfig.aws,
      inboxChains: agentConfig.chainNames
        .filter((name) => name !== chainName)
        .map((remoteChainName) => {
          return {
            name: remoteChainName,
          };
        }),
      validator: {
        enabled: true,
        configs: await chainAgentConfig.validatorConfigs(),
      },
      relayer: {
        enabled: true,
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
  const chainNames = agentConfig.chainNames;
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
      role,
      outboxChainName,
      index,
    );

    // Only the relayer or kathy need to sign txs
    if (role === KEY_ROLE_ENUM.Relayer || role === KEY_ROLE_ENUM.Kathy) {
      chainNames.forEach((name) => {
        envVars.push(
          `ABC_BASE_SIGNERS_${name.toUpperCase()}_KEY=${strip0x(
            gcpKeys[keyId].privateKey,
          )}`,
        );
        envVars.push(`ABC_BASE_SIGNERS_${name.toUpperCase()}_TYPE=hexKey`);
      });
    } else if (role === KEY_ROLE_ENUM.Validator) {
      const privateKey = gcpKeys[keyId].privateKey;

      envVars.push(
        `ABC_VALIDATOR_VALIDATOR_KEY=${strip0x(privateKey)}`,
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
        outboxChainName,
        index!,
        checkpointSyncer.region,
        checkpointSyncer.bucket,
      );
    } else {
      user = new AgentAwsUser(
        agentConfig.environment,
        outboxChainName,
        role,
        agentConfig.aws!.region,
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
      envVars = envVars.concat(
        configEnvVars(
          valueDict.abacus.validator.configs[index!],
          KEY_ROLE_ENUM.Validator,
        ),
      );
      break;
    case KEY_ROLE_ENUM.Relayer:
      envVars = envVars.concat(
        configEnvVars(valueDict.abacus.relayer.config, KEY_ROLE_ENUM.Relayer),
      );
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
) {
  return fetchGCPSecret(`${environment}-rpc-endpoint-${chainName}`, false);
}

export async function getSecretDeployerKey(
  environment: DeployEnvironment,
  chainName: ChainName,
) {
  const key = new AgentGCPKey(environment, KEY_ROLE_ENUM.Deployer, chainName);
  await key.fetch();
  return key.privateKey;
}

async function getSecretRpcEndpoints<Chain extends ChainName>(
  agentConfig: AgentConfig<Chain>,
) {
  const environment = agentConfig.runEnv;
  return getSecretForEachChain(
    agentConfig.chainNames,
    (name: ChainName) => `${environment}-rpc-endpoint-${name}`,
    false,
  );
}

async function getSecretForEachChain(
  chainNames: ChainName[],
  secretNameGetter: (name: ChainName) => string,
  parseJson: boolean,
) {
  const secrets = await Promise.all(
    chainNames.map((name: ChainName) =>
      fetchGCPSecret(secretNameGetter(name), parseJson),
    ),
  );
  return secrets.reduce(
    (prev: any, secret: string, index: number) => ({
      ...prev,
      [chainNames[index]]: secret,
    }),
    {},
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
    `helm ${action} ${outboxChainName} ../../rust/helm/abacus-agent/ --create-namespace --namespace ${
      agentConfig.namespace
    } ${values.join(' ')} ${extraPipe}`,
    {},
    false,
    true,
  );
}

export async function runKeymasterHelmCommand(
  action: HelmCommand,
  agentConfig: AgentConfig<any>,
) {
  const chainNames = agentConfig.chainNames;
  // It's ok to use pick an arbitrary chain here since we are only grabbing the signers
  const chainName = chainNames[0];
  const gcpKeys = (await fetchKeysForChain(agentConfig, chainName)) as Record<
    string,
    AgentGCPKey
  >;
  const bankKey = gcpKeys[KEY_ROLE_ENUM.Bank];
  const config = {
    networks: Object.fromEntries(
      await Promise.all(
        chainNames.map(async (name) => {
          return [
            name,
            {
              endpoint: await getSecretRpcEndpoint(
                agentConfig.environment,
                name,
              ),
              bank: {
                signer: ensure0x(bankKey.privateKey),
                address: bankKey.address,
              },
              threshold: 200000000000000000,
            },
          ];
        }),
      ),
    ),
    homes: Object.fromEntries(
      chainNames.map((name) => {
        return [
          name,
          {
            replicas: chainNames,
            addresses: Object.fromEntries(
              KEY_ROLES.filter((_) => _.endsWith('signer')).map((role) => [
                role,
                gcpKeys[role].address,
              ]),
            ),
          },
        ];
      }),
    ),
  };

  await writeFile(`config.json`, JSON.stringify(config));

  await execCmd(
    `helm ${action} keymaster-${agentConfig.environment} ../../tools/keymaster/helm/keymaster/ --namespace ${agentConfig.namespace} --set-file keymaster.config=config.json`,
    {},
    false,
    true,
  );

  await rm('config.json');
  return;
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
