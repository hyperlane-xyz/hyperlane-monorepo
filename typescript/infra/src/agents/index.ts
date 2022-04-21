import { rm, writeFile } from 'fs/promises';
import { ChainName } from '@abacus-network/sdk';

import { AgentConfig } from '../config';
import { fetchGCPSecret } from '../utils/gcloud';
import { HelmCommand, helmifyValues } from '../utils/helm';
import { ensure0x, execCmd, strip0x } from '../utils/utils';
import { AgentGCPKey, fetchAgentGCPKeys } from './gcp';
import { AgentAwsKey } from './aws';
import { ChainAgentConfig } from '../config/agent';

export enum KEY_ROLE_ENUM {
  Validator = 'validator',
  Checkpointer = 'checkpointer',
  Relayer = 'relayer',
  Deployer = 'deployer',
  Bank = 'bank',
}

export const KEY_ROLES = [
  'validator',
  'checkpointer',
  'relayer',
  'deployer',
  'bank',
];

async function helmValuesForChain(
  chainName: ChainName,
  agentConfig: AgentConfig,
  chainNames: ChainName[],
) {
  // Credentials are only needed if AWS keys are needed -- otherwise, the
  // key is pulled from GCP Secret Manager by the helm chart
  const credentials = (role: KEY_ROLE_ENUM) => {
    if (agentConfig.aws) {
      const key = new AgentAwsKey(agentConfig, role, chainName);
      return key.credentialsAsHelmValue;
    }
    return undefined;
  };

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
        signer: {
          ...credentials(KEY_ROLE_ENUM.Validator),
        },
        configs: chainAgentConfig.validatorConfigs,
      },
      relayer: {
        enabled: true,
        signers: chainNames.map((name) => ({
          name,
          ...credentials(KEY_ROLE_ENUM.Relayer),
        })),
        config: chainAgentConfig.relayerConfig,
      },
      checkpointer: {
        enabled: true,
        signers: chainNames.map((name) => ({
          name,
          ...credentials(KEY_ROLE_ENUM.Checkpointer),
        })),
        config: chainAgentConfig.checkpointerConfig,
      },
    },
  };
}

export async function getAgentEnvVars(
  outboxChainName: ChainName,
  role: KEY_ROLE_ENUM,
  agentConfig: AgentConfig,
  chainNames: ChainName[],
) {
  const valueDict = await helmValuesForChain(
    outboxChainName,
    agentConfig,
    chainNames,
  );
  const envVars: string[] = [];
  const rpcEndpoints = await getSecretRpcEndpoints(agentConfig, chainNames);
  envVars.push(
    `OPT_BASE_OUTBOX_CONNECTION_URL=${rpcEndpoints[outboxChainName]}`,
  );
  valueDict.abacus.inboxChains.forEach((replicaChain: any) => {
    envVars.push(
      `OPT_BASE_INBOXES_${replicaChain.name.toUpperCase()}_CONNECTION_URL=${
        rpcEndpoints[replicaChain.name]
      }`,
    );
  });

  // Base vars from config map
  envVars.push(`BASE_CONFIG=${valueDict.abacus.baseConfig}`);
  envVars.push(`RUN_ENV=${agentConfig.runEnv}`);
  envVars.push(`OPT_BASE_METRICS=9090`);
  envVars.push(`OPT_BASE_TRACING_LEVEL=info`);
  envVars.push(
    `OPT_BASE_DB=/tmp/${agentConfig.environment}-${role}-${outboxChainName}-db`,
  );

  try {
    const gcpKeys = await fetchAgentGCPKeys(
      agentConfig.environment,
      outboxChainName,
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
      envVars.push(
        `OPT_BASE_VALIDATOR_KEY=${strip0x(
          gcpKeys[outboxChainName + '-' + KEY_ROLE_ENUM.Validator].privateKey,
        )}`,
        `OPT_BASE_VALIDATOR_TYPE=hexKey`,
      );
      // Throw an error if the chain config did not specify the reorg period
      if (valueDict.abacus.validator.configs[0].reorgPeriod === undefined) {
        throw new Error(
          `Panic: Chain config for ${outboxChainName} did not specify a reorg period`,
        );
      }

      envVars.push(
        `OPT_VALIDATOR_REORGPERIOD=${
          valueDict.abacus.validator.configs[0].reorgPeriod - 1
        }`,
        `OPT_VALIDATOR_INTERVAL=${valueDict.abacus.validator.configs[0].interval}`,
      );
    }

    if (role === KEY_ROLE_ENUM.Relayer) {
      envVars.push(
        `OPT_RELAYER_INTERVAL=${valueDict.abacus.relayer.config?.pollingInterval}`,
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
        const key = new AgentAwsKey(agentConfig, role, name);
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
      const key = new AgentAwsKey(agentConfig, role, outboxChainName);
      envVars.push(`OPT_BASE_VALIDATOR_TYPE=aws`);
      envVars.push(
        `OPT_BASE_VALIDATOR_ID=${key.credentialsAsHelmValue.aws.keyId}`,
      );
      envVars.push(
        `OPT_BASE_VALIDATOR_REGION=${key.credentialsAsHelmValue.aws.region}`,
      );
    }
  }

  if (role === KEY_ROLE_ENUM.Checkpointer) {
    envVars.push(
      `OPT_CHECKPOINTER_POLLINGINTERVAL=${agentConfig.checkpointer?.default.pollingInterval}`,
    );
    envVars.push(
      `OPT_CHECKPOINTER_CREATIONLATENCY=${agentConfig.checkpointer?.default.creationLatency}`,
    );
  }

  return envVars;
}

export async function getSecretAwsCredentials(agentConfig: AgentConfig) {
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

async function getSecretRpcEndpoints(
  agentConfig: AgentConfig,
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

export async function runAgentHelmCommand(
  action: HelmCommand,
  agentConfig: AgentConfig,
  outboxChainName: ChainName,
  chainNames: ChainName[],
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

export async function runKeymasterHelmCommand(
  action: HelmCommand,
  agentConfig: AgentConfig,
  chainNames: ChainName[],
) {
  // It's ok to use pick an arbitrary chain here since we are only grabbing the signers
  const gcpKeys = await fetchAgentGCPKeys(
    agentConfig.environment,
    chainNames[0],
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
