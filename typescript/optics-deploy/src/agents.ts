import { rm, writeFile } from 'fs/promises';
import { ChainJson } from './chain';
import { ensure0x, execCmd, include, strip0x } from './utils';
import { getAgentGCPKeys, memoryKeyIdentifier, SecretManagerPersistedKeys } from "./agents/gcp";

export interface AgentConfig {
  environment: string;
  namespace: string;
  runEnv: string;
  awsRegion?: string;
  awsKeyId?: string;
  awsSecretAccessKey?: string;
  processorIndexOnly?: string[];
  processorS3Bucket?: string;
  dockerImageRepo: string;
  dockerImageTag: string;
}

export interface AgentChainConfigs {
  [name: string]: ChainJson;
}


export enum KEY_ROLE_ENUM {
  UpdaterAttestation = 'updater-attestation',
  UpdaterSigner = 'updater-signer',
  ProcessorSigner = 'processor-signer',
  RelayerSigner = 'relayer-signer',
  WatcherAttestation = 'watcher-attestation',
  WatcherSigner = 'watcher-signer',
  Deployer = 'deployer',
  Bank = 'bank',
}
export const KEY_ROLES = [
  'updater-attestation',
  'updater-signer',
  'processor-signer',
  'relayer-signer',
  'watcher-attestation',
  'watcher-signer',
  'deployer',
  'bank',
];

export enum HelmCommand {
  Install = 'install',
  Upgrade = 'upgrade',
}

const awsSignerCredentials = (
  role: KEY_ROLE_ENUM,
  agentConfig: AgentConfig,
  homeChainName: string,
) => {
  // When staging-community was deployed, we mixed up the attestation and signer keys, so we have to switch for this environment
  const adjustedRole =
    agentConfig.environment === 'staging-community' &&
    role === KEY_ROLE_ENUM.UpdaterAttestation
      ? KEY_ROLE_ENUM.UpdaterSigner
      : agentConfig.environment === 'staging-community' &&
        role === KEY_ROLE_ENUM.UpdaterSigner
      ? KEY_ROLE_ENUM.UpdaterAttestation
      : role;
  return {
    aws: {
      keyId: `alias/${agentConfig.runEnv}-${homeChainName}-${adjustedRole}`,
      region: agentConfig.awsRegion,
    },
  };
};

async function helmValuesForChain(
  chainName: string,
  agentConfig: AgentConfig,
  configs: AgentChainConfigs,
) {
  let gcpKeys: { [role: string]: SecretManagerPersistedKeys } | undefined =
    undefined;
  try {
    gcpKeys = await getAgentGCPKeys(agentConfig.environment, chainName);
  } catch (error) {
    if (
      !agentConfig.awsRegion ||
      !agentConfig.awsKeyId ||
      !agentConfig.awsSecretAccessKey
    ) {
      throw new Error("agents' keys are neither in GCP nor in AWS");
    }
  }

  const credentials = (role: KEY_ROLE_ENUM) => {
    if (!!gcpKeys) {
      const identifier = memoryKeyIdentifier(role, chainName);
      return { hexKey: strip0x(gcpKeys![identifier].privateKey) };
    } else {
      return awsSignerCredentials(role, agentConfig, chainName);
    }
  };

  return {
    image: {
      repository: agentConfig.dockerImageRepo,
      tag: agentConfig.dockerImageTag,
    },
    optics: {
      runEnv: agentConfig.runEnv,
      baseConfig: `${chainName}_config.json`,
      homeChain: {
        name: chainName,
        connectionUrl: configs[chainName].rpc,
      },
      ...include(!gcpKeys, {
        aws: {
          accessKeyId: agentConfig.awsKeyId,
          secretAccessKey: agentConfig.awsSecretAccessKey,
        },
      }),
      replicaChains: Object.keys(configs)
        .filter((_) => _ !== chainName)
        .map((replica) => {
          const replicaConfig = configs[replica];
          return {
            name: replica,
            connectionUrl: replicaConfig.rpc,
          };
        }),
      updater: {
        enabled: true,
        transactionSigners: Object.keys(configs).map((chain) => ({
          name: configs[chain].name,
          ...credentials(KEY_ROLE_ENUM.UpdaterSigner),
        })),
        attestationSigner: {
          ...credentials(KEY_ROLE_ENUM.UpdaterAttestation),
        },
      },
      relayer: {
        enabled: true,
        transactionSigners: Object.keys(configs).map((chain) => ({
          name: configs[chain].name,
          ...credentials(KEY_ROLE_ENUM.RelayerSigner),
        })),
      },
      processor: {
        enabled: true,
        transactionSigners: Object.keys(configs).map((chain) => ({
          name: configs[chain].name,
          ...credentials(KEY_ROLE_ENUM.ProcessorSigner),
        })),
        indexonly: agentConfig.processorIndexOnly || [],
        s3BucketName: agentConfig.processorS3Bucket || '',
      },
    },
  };
}

function helmifyValues(config: any, prefix?: string): string[] {
  if (typeof config !== 'object') {
    return [`--set ${prefix}=${JSON.stringify(config)}`];
  }

  if (config.flatMap) {
    return config.flatMap((value: any, index: number) => {
      return helmifyValues(value, `${prefix}[${index}]`);
    });
  }
  return Object.keys(config).flatMap((key) => {
    const value = config[key];
    return helmifyValues(value, prefix ? `${prefix}.${key}` : key);
  });
}

export async function getAgentEnvVars(
  home: string,
  role: KEY_ROLE_ENUM,
  agentConfig: AgentConfig,
  configs: AgentChainConfigs,
) {
  const valueDict = await helmValuesForChain(home, agentConfig, configs);
  const envVars: string[] = [];

  // Base vars from config map
  envVars.push(`BASE_CONFIG=${valueDict.optics.baseConfig}`);
  envVars.push(
    `OPT_BASE_HOME_CONNECTION_URL=${valueDict.optics.homeChain.connectionUrl}`,
  );
  envVars.push(`RUN_ENV=${agentConfig.runEnv}`);
  valueDict.optics.replicaChains.forEach((replicaChain: any) => {
    envVars.push(
      `OPT_BASE_REPLICAS_${replicaChain.name.toUpperCase()}_CONNECTION_URL=${
        replicaChain.connectionUrl
      }`,
    );
  });

  try {
    const gcpKeys = await getAgentGCPKeys(agentConfig.environment, home);
    // Signer keys
    Object.keys(configs).forEach((network) => {
      envVars.push(
        `OPT_BASE_SIGNERS_${network.toUpperCase()}_KEY=${strip0x(
          gcpKeys[role].privateKey,
        )}`,
      );
    });

    // Updater attestation key
    if (role.startsWith('updater')) {
      envVars.push(
        `OPT_BASE_UPDATER_KEY=${strip0x(
          gcpKeys[home + '-' + KEY_ROLE_ENUM.UpdaterAttestation].privateKey,
        )}`,
      );
    }
  } catch (error) {
    // Keys are in AWS
    envVars.push(`AWS_ACCESS_KEY_ID=${valueDict.optics.aws.accessKeyId}`);
    envVars.push(
      `AWS_SECRET_ACCESS_KEY=${valueDict.optics.aws.secretAccessKey}`,
    );

    // Signers
    Object.keys(configs).forEach((network) => {
      const awsSigner = awsSignerCredentials(role, agentConfig, home);
      envVars.push(`OPT_BASE_SIGNERS_${network.toUpperCase()}_TYPE=aws`);
      envVars.push(
        `OPT_BASE_SIGNERS_${network.toUpperCase()}_ID=${awsSigner.aws.keyId}`,
      );
      envVars.push(
        `OPT_BASE_SIGNERS_${network.toUpperCase()}_REGION=${
          awsSigner.aws.region
        }`,
      );
    });

    // Updater attestation key
    if (role.startsWith('updater')) {
      const awsSigner = awsSignerCredentials(role, agentConfig, home);
      envVars.push(`OPT_BASE_UPDATER_TYPE=aws`);
      envVars.push(`OPT_BASE_UPDATER_ID=${awsSigner.aws.keyId}`);
      envVars.push(`OPT_BASE_UPDATER_REGION=${awsSigner.aws.region}`);
    }
  }

  return envVars;
}

export async function runAgentHelmCommand(
  action: HelmCommand,
  agentConfig: AgentConfig,
  homeConfig: ChainJson,
  configs: AgentChainConfigs,
) {
  const valueDict = await helmValuesForChain(
    homeConfig.name,
    agentConfig,
    configs,
  );
  const values = helmifyValues(valueDict);
  return execCmd(
    `helm ${action} ${
      homeConfig.name
    } ../../rust/helm/optics-agent/ --namespace ${
      agentConfig.namespace
    } ${values.join(' ')}`,
    {},
    false,
    true,
  );
}

export async function runKeymasterHelmCommand(
  action: HelmCommand,
  agentConfig: AgentConfig,
  configs: AgentChainConfigs,
) {
  // It's ok to use pick an arbitrary chain here since we are only grabbing the signers
  const gcpKeys = await getAgentGCPKeys(
    agentConfig.environment,
    configs[0].name,
  );
  const bankKey = gcpKeys[KEY_ROLE_ENUM.Bank];
  const config = {
    networks: mapPairs(configs, (home, chain) => {
      return [
        home,
        {
          endpoint: chain.rpc,
          bank: {
            signer: ensure0x(bankKey.privateKey),
            address: bankKey.address,
          },
          threshold: 200000000000000000,
        },
      ];
    }),
    homes: mapPairs(configs, (home, chain) => {
      return [
        home,
        {
          replicas: Object.keys(configs),
          addresses: Object.fromEntries(
            KEY_ROLES.filter((_) => _.endsWith('signer')).map((role) => [
              role,
              gcpKeys[role].address,
            ]),
          ),
        },
      ];
    }),
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

function mapPairs<V, R>(
  dict: { [k: string]: V },
  f: (key: string, value: V) => [string, R],
) {
  return Object.fromEntries(Object.keys(dict).map((key) => f(key, dict[key])));
}
