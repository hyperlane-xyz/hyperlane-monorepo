import { ethers } from 'ethers';
import { rm, writeFile } from 'fs/promises';
import { AgentConfig, ChainConfig, ChainName } from '../config';
import { fetchGCPSecret } from '../utils/gcloud';
import { HelmCommand, helmifyValues } from '../utils/helm';
import { ensure0x, execCmd, include, strip0x } from '../utils/utils';
import { fetchAgentGCPKeys } from './gcp';
import { AgentAwsKey } from './aws';

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
  chains: ChainConfig[],
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

  const chain = chains.find((_) => _.name === chainName)!;

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
      replicaChains: chains
        .filter((_) => _.name !== chainName)
        .map((remoteChain) => {
          return {
            name: remoteChain.name,
          };
        }),
      validator: {
        enabled: true,
        attestationSigner: {
          ...credentials(KEY_ROLE_ENUM.Validator),
        },
        reorg_period: chain.confirmations,
        ...include(!!agentConfig.validator?.interval, {
          pollingInterval: agentConfig.validator?.interval || '',
        }),
        ...include(!!agentConfig.validator?.pause, {
          updatePause: agentConfig.validator?.pause || '',
        }),
      },
      relayer: {
        enabled: true,
        transactionSigners: chains.map((chain) => ({
          name: chain.name,
          ...credentials(KEY_ROLE_ENUM.Relayer),
        })),
        ...include(!!agentConfig.validator?.interval, {
          pollingInterval: agentConfig.validator?.interval || '',
        }),
      },
      checkpointer: {
        enabled: true,
        transactionSigners: chains.map((chain) => ({
          name: chain.name,
          ...credentials(KEY_ROLE_ENUM.Checkpointer),
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
  chains: ChainConfig[],
) {
  const valueDict = await helmValuesForChain(
    homeChainName,
    agentConfig,
    chains,
  );
  const envVars: string[] = [];
  const rpcEndpoints = await getSecretRpcEndpoints(agentConfig, chains);
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

    // Only checkpointer and relayer need to sign txs
    if (role === KEY_ROLE_ENUM.Checkpointer || role === KEY_ROLE_ENUM.Relayer) {
      chains.forEach((network) => {
        envVars.push(
          `OPT_BASE_SIGNERS_${network.name.toUpperCase()}_KEY=${strip0x(
            gcpKeys[role].privateKey,
          )}`,
        );
      });
    } else if (role === KEY_ROLE_ENUM.Validator) {
      envVars.push(
        `OPT_BASE_VALIDATOR_KEY=${strip0x(
          gcpKeys[homeChainName + '-' + KEY_ROLE_ENUM.Validator].privateKey,
        )}`,
        `OPT_BASE_VALIDATOR_TYPE=hexKey`,
      );
      // Throw an error if the chain config did not specify the reorg period
      if (valueDict.optics.validator.reorg_period === undefined) {
        throw new Error(
          `Panic: Chain config for ${homeChainName} did not specify a reorg period`,
        );
      }

      envVars.push(
        `OPT_VALIDATOR_REORGPERIOD=${
          valueDict.optics.validator.reorg_period! - 1
        }`,
        `OPT_VALIDATOR_INTERVAL=${valueDict.optics.validator.pollingInterval}`,
      );
    }

    if (role === KEY_ROLE_ENUM.Relayer) {
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

    // Only checkpointer and relayer need to sign txs
    if (role === KEY_ROLE_ENUM.Checkpointer || role === KEY_ROLE_ENUM.Relayer) {
      Object.keys(chains).forEach((network) => {
        const key = new AgentAwsKey(agentConfig, role, network);
        envVars.push(`OPT_BASE_SIGNERS_${network.toUpperCase()}_TYPE=aws`);
        envVars.push(
          `OPT_BASE_SIGNERS_${network.toUpperCase()}_ID=${
            key.credentialsAsHelmValue.aws.keyId
          }`,
        );
        envVars.push(
          `OPT_BASE_SIGNERS_${network.toUpperCase()}_REGION=${
            key.credentialsAsHelmValue.aws.region
          }`,
        );
      });
    }

    // Validator attestation key
    if (role === KEY_ROLE_ENUM.Validator) {
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

  if (role.startsWith('checkpointer')) {
    envVars.push(
      `OPT_CHECKPOINTER_POLLINGINTERVAL=${agentConfig.checkpointer?.pollingInterval}`,
    );
    envVars.push(
      `OPT_CHECKPOINTER_CREATIONLATENCY=${agentConfig.checkpointer?.creationLatency}`,
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
  chains: ChainConfig[],
) {
  const environment = agentConfig.runEnv;
  return getSecretForEachChain(
    chains,
    (chain: ChainConfig) => `${environment}-rpc-endpoint-${chain.name}`,
    false,
  );
}

async function getSecretForEachChain(
  chains: ChainConfig[],
  secretNameGetter: (chain: ChainConfig) => string,
  parseJson: boolean,
) {
  const secrets = await Promise.all(
    chains.map((chain: ChainConfig) =>
      fetchGCPSecret(secretNameGetter(chain), parseJson),
    ),
  );
  return secrets.reduce(
    (prev: any, secret: string, index: number) => ({
      ...prev,
      [chains[index].name]: secret,
    }),
    {},
  );
}

export async function runAgentHelmCommand(
  action: HelmCommand,
  agentConfig: AgentConfig,
  homeChainConfig: ChainConfig,
  chains: ChainConfig[],
) {
  const valueDict = await helmValuesForChain(
    homeChainConfig.name as ChainName,
    agentConfig,
    chains,
  );
  const values = helmifyValues(valueDict);

  const extraPipe =
    action === HelmCommand.UpgradeDiff
      ? ` | kubectl diff -n ${agentConfig.namespace} --field-manager="Go-http-client" -f - || true`
      : '';

  return execCmd(
    `helm ${action} ${
      homeChainConfig.name
    } ../../rust/helm/abacus-agent/ --namespace ${
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
  chains: ChainConfig[],
) {
  // It's ok to use pick an arbitrary chain here since we are only grabbing the signers
  const gcpKeys = await fetchAgentGCPKeys(
    agentConfig.environment,
    chains[0].name,
  );
  const bankKey = gcpKeys[KEY_ROLE_ENUM.Bank];
  const config = {
    networks: Object.fromEntries(
      chains.map((chain) => {
        return [
          chain.name,
          {
            endpoint: (
              chain.signer.provider as ethers.providers.JsonRpcProvider
            ).connection.url,
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
      chains.map((chain) => {
        return [
          chain.name,
          {
            replicas: chains.map((c) => c.name),
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
