import { rm, writeFile } from 'fs/promises';
import { ChainName } from '@abacus-network/sdk';

import { AgentConfig } from '../config';
import { fetchGCPSecret } from '../utils/gcloud';
import { HelmCommand, helmifyValues } from '../utils/helm';
import { ensure0x, execCmd, strip0x } from '../utils/utils';
import { AgentGCPKey, fetchAgentGCPKeys, memoryKeyIdentifier } from './gcp';
import { AgentAwsKey } from './aws/key';
import { ChainAgentConfig } from '../config/agent';

export enum KEY_ROLE_ENUM {
  Validator = 'validator',
  Checkpointer = 'checkpointer',
  Relayer = 'relayer',
  Deployer = 'deployer',
  Bank = 'bank',
  Kathy = 'kathy',
}

export const KEY_ROLES = [
  KEY_ROLE_ENUM.Validator,
  KEY_ROLE_ENUM.Checkpointer,
  KEY_ROLE_ENUM.Relayer,
  KEY_ROLE_ENUM.Deployer,
  KEY_ROLE_ENUM.Bank,
  KEY_ROLE_ENUM.Kathy,
];

async function helmValuesForChain<Networks extends ChainName>(
  chainName: Networks,
  agentConfig: AgentConfig<Networks>,
  chainNames: Networks[],
) {
  // // Credentials are only needed if AWS keys are needed -- otherwise, the
  // // key is pulled from GCP Secret Manager by the helm chart
  // const credentials = (role: KEY_ROLE_ENUM) => {
  //   if (agentConfig.aws) {
  //     const key = new AgentAwsKey(agentConfig, role, chainName);
  //     return key.credentialsAsHelmValue;
  //   }
  //   return undefined;
  // };

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
      inboxChains: chainNames
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
        signers: chainAgentConfig.relayerSigners,
        aws: await chainAgentConfig.relayerRequiresAwsCredentials(),
        config: chainAgentConfig.relayerConfig,
      },
      checkpointer: {
        enabled: true,
        signers: await chainAgentConfig.checkpointerSigners(),
        config: chainAgentConfig.checkpointerConfig,
      },
      kathy: {
        enabled: chainAgentConfig.kathyEnabled,
        signers: await chainAgentConfig.kathySigners(),
        config: chainAgentConfig.kathyConfig,
      },
    },
  };
}

export async function getAgentEnvVars<Networks extends ChainName>(
  outboxChainName: Networks,
  role: KEY_ROLE_ENUM,
  agentConfig: AgentConfig<Networks>,
  chainNames: Networks[],
  index?: number,
) {
  if (role === KEY_ROLE_ENUM.Validator && index === undefined) {
    throw Error('Expected index for validator role');
  }

  const valueDict = await helmValuesForChain(
    outboxChainName,
    agentConfig,
    chainNames,
  );
  let envVars: string[] = [];
  const rpcEndpoints = await getSecretRpcEndpoints(agentConfig, chainNames);
  envVars.push(
    `OPT_BASE_OUTBOX_CONNECTION_URL=${rpcEndpoints[outboxChainName]}`,
  );
  valueDict.abacus.inboxChains.forEach((inboxChain: any) => {
    envVars.push(
      `OPT_BASE_INBOXES_${inboxChain.name.toUpperCase()}_CONNECTION_URL=${
        rpcEndpoints[inboxChain.name]
      }`,
    );
  });

  // Base vars from config map
  envVars.push(`BASE_CONFIG=${valueDict.abacus.baseConfig}`);
  envVars.push(`RUN_ENV=${agentConfig.runEnv}`);
  envVars.push(`OPT_BASE_METRICS=9090`);
  envVars.push(`OPT_BASE_TRACING_LEVEL=info`);
  envVars.push(
    `OPT_BASE_DB=/tmp/${agentConfig.environment}-${role}-${outboxChainName}${
      role === KEY_ROLE_ENUM.Validator ? `-${index}` : ''
    }-db`,
  );

  try {
    const gcpKeys = await fetchAgentGCPKeys(
      agentConfig.environment,
      outboxChainName,
      agentConfig.validatorSets[outboxChainName].validators.length,
    );

    // Only checkpointer and relayer need to sign txs
    if (role === KEY_ROLE_ENUM.Checkpointer || role === KEY_ROLE_ENUM.Relayer) {
      chainNames.forEach((name) => {
        envVars.push(
          `OPT_BASE_SIGNERS_${name.toUpperCase()}_KEY=${strip0x(
            gcpKeys[role].privateKey,
          )}`,
        );
        envVars.push(`OPT_BASE_SIGNERS_${name.toUpperCase()}_TYPE=hexKey`);
      });
    } else if (role === KEY_ROLE_ENUM.Validator) {
      const privateKey =
        gcpKeys[memoryKeyIdentifier(role, outboxChainName, index)].privateKey;

      envVars.push(
        `OPT_VALIDATOR_VALIDATOR_KEY=${strip0x(privateKey)}`,
        `OPT_VALIDATOR_VALIDATOR_TYPE=hexKey`,
      );
    }
  } catch (error) {
    // This happens if you don't have a result type
    if ((error as any).toString().includes('Panic')) {
      throw error;
    }

    // Keys are in AWS
    const awsKeys = await getSecretAwsCredentials(agentConfig);

    envVars.push(`AWS_ACCESS_KEY_ID=${awsKeys.accessKeyId}`);
    envVars.push(`AWS_SECRET_ACCESS_KEY=${awsKeys.secretAccessKey}`);

    // Only checkpointer and relayer need to sign txs
    if (role === KEY_ROLE_ENUM.Checkpointer || role === KEY_ROLE_ENUM.Relayer) {
      chainNames.forEach((name) => {
        const key = new AgentAwsKey(agentConfig, name, role);
        envVars.push(`OPT_BASE_SIGNERS_${name.toUpperCase()}_TYPE=aws`);
        envVars.push(
          `OPT_BASE_SIGNERS_${name.toUpperCase()}_ID=${
            key.credentialsAsHelmValue.aws.keyId
          }`,
        );
        envVars.push(
          `OPT_BASE_SIGNERS_${name.toUpperCase()}_REGION=${
            key.credentialsAsHelmValue.aws.region
          }`,
        );
      });
    }

    // Validator attestation key
    if (role === KEY_ROLE_ENUM.Validator) {
      const key = new AgentAwsKey(agentConfig, outboxChainName, role);
      envVars.push(`OPT_BASE_VALIDATOR_TYPE=aws`);
      envVars.push(
        `OPT_BASE_VALIDATOR_ID=${key.credentialsAsHelmValue.aws.keyId}`,
      );
      envVars.push(
        `OPT_BASE_VALIDATOR_REGION=${key.credentialsAsHelmValue.aws.region}`,
      );
    }
  }

  switch (role) {
    case KEY_ROLE_ENUM.Validator:
      envVars.concat(
        configEnvVars(
          valueDict.abacus.validator.configs[index!],
          KEY_ROLE_ENUM.Validator,
        ),
      );
      break;
    case KEY_ROLE_ENUM.Relayer:
      envVars.concat(
        configEnvVars(valueDict.abacus.relayer.config, KEY_ROLE_ENUM.Relayer),
      );
      break;
    case KEY_ROLE_ENUM.Checkpointer:
      envVars.concat(
        configEnvVars(
          valueDict.abacus.checkpointer.config,
          KEY_ROLE_ENUM.Checkpointer,
        ),
      );
      break;
    case KEY_ROLE_ENUM.Kathy:
      if (valueDict.abacus.kathy.config) {
        envVars.concat(
          configEnvVars(valueDict.abacus.kathy.config, KEY_ROLE_ENUM.Kathy),
        );
      }
      break;
  }

  return envVars;
}

// Recursively converts a config object into environment variables than can
// be parsed by rust. For example, a config of { foo: { bar: { baz: 420 }, boo: 421 } } will
// be: OPT_FOO_BAR_BAZ=420 and OPT_FOO_BOO=421
function configEnvVars(
  config: Record<string, any>,
  role: string,
  key_name_prefix: string = '',
) {
  let envVars: string[] = [];
  for (const key of Object.keys(config)) {
    const value = config[key];
    if (typeof value === 'object') {
      envVars = [
        ...envVars,
        ...configEnvVars(value, role, `${key.toUpperCase()}_`),
      ];
    } else {
      envVars.push(
        `OPT_${role.toUpperCase()}_${key_name_prefix}${key.toUpperCase()}=${
          config[key]
        }`,
      );
    }
  }
  return envVars;
}

export async function getSecretAwsCredentials<Networks extends ChainName>(
  agentConfig: AgentConfig<Networks>,
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
  environment: string,
  chainName: string,
) {
  const key = new AgentGCPKey(environment, KEY_ROLE_ENUM.Deployer, chainName);
  await key.fetch();
  return key.privateKey;
}

async function getSecretRpcEndpoints<Networks extends ChainName>(
  agentConfig: AgentConfig<Networks>,
  chainNames: ChainName[],
) {
  const environment = agentConfig.runEnv;
  return getSecretForEachChain(
    chainNames,
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

export async function runAgentHelmCommand<Networks extends ChainName>(
  action: HelmCommand,
  agentConfig: AgentConfig<Networks>,
  outboxChainName: Networks,
  chainNames: Networks[],
) {
  const valueDict = await helmValuesForChain(
    outboxChainName,
    agentConfig,
    chainNames,
  );
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

export async function runKeymasterHelmCommand<Networks extends ChainName>(
  action: HelmCommand,
  agentConfig: AgentConfig<Networks>,
  chainNames: Networks[],
) {
  // It's ok to use pick an arbitrary chain here since we are only grabbing the signers
  const chainName = chainNames[0];
  const gcpKeys = await fetchAgentGCPKeys(
    agentConfig.environment,
    chainName,
    agentConfig.validatorSets[chainName].validators.length,
  );
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
