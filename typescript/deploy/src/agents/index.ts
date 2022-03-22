import { rm, writeFile } from 'fs/promises';
import { ChainName } from '@abacus-network/sdk';

import { AgentConfig } from '../config';
import { fetchGCPSecret } from '../utils/gcloud';
import { HelmCommand, helmifyValues } from '../utils/helm';
import { ensure0x, execCmd, include, strip0x } from '../utils/utils';
import { fetchAgentGCPKeys } from './gcp';
import { AgentAwsKey } from './aws';

export enum KEY_ROLE_ENUM {
  UpdaterAttestation = 'validator-attestation',
  UpdaterSigner = 'validator-signer',
  CheckpointerSigner = 'checkpointer-signer',
  RelayerSigner = 'relayer-signer',
  WatcherAttestation = 'watcher-attestation',
  WatcherSigner = 'watcher-signer',
  Deployer = 'deployer',
  Bank = 'bank',
}

export const KEY_ROLES = [
  'validator-attestation',
  'validator-signer',
  'checkpointer-signer',
  'relayer-signer',
  'watcher-attestation',
  'watcher-signer',
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

  return {
    image: {
      repository: agentConfig.docker.repo,
      tag: agentConfig.docker.tag,
    },
    optics: {
      runEnv: agentConfig.runEnv,
      baseConfig: `${chainName}_config.json`,
      homeChain: {
        name: chainName,
      },
      aws: !!agentConfig.aws,
      replicaChains: chainNames
        .filter((name) => name !== chainName)
        .map((remoteChainName) => {
          return {
            name: remoteChainName,
          };
        }),
      validator: {
        enabled: true,
        transactionSigners: chainNames.map((name) => ({
          name,
          ...credentials(KEY_ROLE_ENUM.UpdaterSigner),
        })),
        attestationSigner: {
          ...credentials(KEY_ROLE_ENUM.UpdaterAttestation),
        },
        reorg_period: agentConfig.validator?.confirmations,
        ...include(!!agentConfig.validator?.interval, {
          pollingInterval: agentConfig.validator?.interval || '',
        }),
        ...include(!!agentConfig.validator?.pause, {
          updatePause: agentConfig.validator?.pause || '',
        }),
      },
      relayer: {
        enabled: true,
        transactionSigners: chainNames.map((name) => ({
          name,
          ...credentials(KEY_ROLE_ENUM.RelayerSigner),
        })),
        ...include(!!agentConfig.validator?.interval, {
          pollingInterval: agentConfig.validator?.interval || '',
        }),
      },
      processor: {
        enabled: true,
        transactionSigners: chainNames.map((name) => ({
          name,
          ...credentials(KEY_ROLE_ENUM.CheckpointerSigner),
        })),
        indexonly: agentConfig.processor?.indexOnly || [],
        s3BucketName: agentConfig.processor?.s3Bucket || '',
        s3BucketRegion: agentConfig.aws?.region || '',
      },
    },
  };
}

export async function getAgentEnvVars(
  homeChainName: ChainName,
  role: KEY_ROLE_ENUM,
  agentConfig: AgentConfig,
  chainNames: ChainName[],
) {
  const valueDict = await helmValuesForChain(
    homeChainName,
    agentConfig,
    chainNames
  );
  const envVars: string[] = [];
  const rpcEndpoints = await getSecretRpcEndpoints(agentConfig, chainNames);
  envVars.push(`OPT_BASE_HOME_CONNECTION_URL=${rpcEndpoints[homeChainName]}`);
  valueDict.optics.replicaChains.forEach((replicaChain: any) => {
    envVars.push(
      `OPT_BASE_REPLICAS_${replicaChain.name.toUpperCase()}_CONNECTION_URL=${
        rpcEndpoints[replicaChain.name]
      }`,
    );
  });

  // Base vars from config map
  envVars.push(`BASE_CONFIG=${valueDict.optics.baseConfig}`);
  envVars.push(`RUN_ENV=${agentConfig.runEnv}`);
  envVars.push(`OPT_BASE_METRICS=9090`);
  envVars.push(`OPT_BASE_TRACING_LEVEL=info`);
  envVars.push(
    `OPT_BASE_DB=/tmp/${agentConfig.environment}-${role}-${homeChainName}-db`,
  );

  try {
    const gcpKeys = await fetchAgentGCPKeys(
      agentConfig.environment,
      homeChainName,
    );
    // Signer keys
    chainNames.forEach((name) => {
      envVars.push(
        `OPT_BASE_SIGNERS_${name.toUpperCase()}_KEY=${strip0x(
          gcpKeys[role].privateKey,
        )}`,
      );
    });

    // Updater attestation key
    if (role.startsWith('validator')) {
      envVars.push(
        `OPT_BASE_VALIDATOR_KEY=${strip0x(
          gcpKeys[homeChainName + '-' + KEY_ROLE_ENUM.UpdaterAttestation]
            .privateKey,
        )}`,
        `OPT_BASE_VALIDATOR_TYPE=hexKey`,
      );
      envVars.push(
        `OPT_VALIDATOR_REORGPERIOD=${valueDict.optics.validator.reorg_period}`,
        `OPT_VALIDATOR_INTERVAL=${valueDict.optics.validator.pollingInterval}`,
      );
    }

    if (role.startsWith('relayer')) {
      envVars.push(
        `OPT_RELAYER_INTERVAL=${valueDict.optics.relayer.pollingInterval}`,
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

    // Signers
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

    // Validator attestation key
    if (role.startsWith('validator')) {
      const key = new AgentAwsKey(agentConfig, role, homeChainName);
      envVars.push(`OPT_BASE_VALIDATOR_TYPE=aws`);
      envVars.push(
        `OPT_BASE_VALIDATOR_ID=${key.credentialsAsHelmValue.aws.keyId}`,
      );
      envVars.push(
        `OPT_BASE_VALIDATOR_REGION=${key.credentialsAsHelmValue.aws.region}`,
      );
    }
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
  network: string,
) {
  return fetchGCPSecret(`${environment}-rpc-endpoint-${network}`, false);
}

export async function getSecretDeployerKey(deployerKeySecretName: string) {
  const keyObject = await fetchGCPSecret(deployerKeySecretName, true);
  return keyObject.privateKey;
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
  homeChainName: ChainName,
  chainNames: ChainName[],
) {
  const valueDict = await helmValuesForChain(
    homeChainName,
    agentConfig,
    chainNames,
  );
  const values = helmifyValues(valueDict);

  const extraPipe =
    action === HelmCommand.UpgradeDiff
      ? ` | kubectl diff -n ${agentConfig.namespace} --field-manager="Go-http-client" -f - || true`
      : '';

  return execCmd(
    `helm ${action} ${homeChainName} ../../rust/helm/abacus-agent/ --namespace ${
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
      chainNames.map((name) => {
        return [
          name,
          {
            endpoint: await getSecretRpcEndpoint(agentConfig.environment, name),
            bank: {
              signer: ensure0x(bankKey.privateKey),
              address: bankKey.address,
            },
            threshold: 200000000000000000,
          },
        ];
      }),
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
