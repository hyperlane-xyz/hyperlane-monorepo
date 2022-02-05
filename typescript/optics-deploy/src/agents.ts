import { rm, writeFile } from 'fs/promises';
import { ChainName, ChainConfig } from './config/chain';
import { AgentConfig } from './config/agent';
import { ensure0x, execCmd, include, strip0x } from './utils';
import {
  AgentGCPKey,
  fetchAgentGCPKeys,
  memoryKeyIdentifier,
} from './agents/gcp';
import { AgentAwsKey } from './agents/aws';

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

async function helmValuesForChain(
  chainName: ChainName,
  agentConfig: AgentConfig,
  chainConfigs: ChainConfig[],
) {
  let gcpKeys: { [role: string]: AgentGCPKey } | undefined = undefined;
  try {
    gcpKeys = await fetchAgentGCPKeys(agentConfig.environment, chainName);
  } catch (error) {
    if (!agentConfig.aws) {
      throw new Error("agents' keys are neither in GCP nor in AWS");
    }
  }

  const credentials = (role: KEY_ROLE_ENUM) => {
    if (!!gcpKeys) {
      const identifier = memoryKeyIdentifier(role, chainName);
      return gcpKeys![identifier].credentialsAsHelmValue;
    } else {
      const key = new AgentAwsKey(agentConfig, role, chainName);
      return key.credentialsAsHelmValue;
    }
  };
  const aws: any = {};
  if (agentConfig.aws) {
    aws.accessKeyId = agentConfig.aws.keyId
    aws.secretAccessKey = agentConfig.aws.secretAccessKey
  }
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
        connectionUrl: chainConfigs.filter((_) => _.name === chainName)[0].json.rpc
      },
      ...include(!gcpKeys, {
        aws,
      }),
      replicaChains: chainConfigs.filter((_) => _.name !== chainName)
        .map((remoteChain) => {
          return {
            name: remoteChain.name,
            connectionUrl: remoteChain.json.rpc,
          };
        }),
      updater: {
        enabled: true,
        transactionSigners: chainConfigs.map((chainConfig) => ({
          name: chainConfig.name,
          ...credentials(KEY_ROLE_ENUM.UpdaterSigner),
        })),
        attestationSigner: {
          ...credentials(KEY_ROLE_ENUM.UpdaterAttestation),
        },
      },
      relayer: {
        enabled: true,
        transactionSigners: chainConfigs.map((chainConfig) => ({
          name: chainConfig.name,
          ...credentials(KEY_ROLE_ENUM.RelayerSigner),
        })),
      },
      processor: {
        enabled: true,
        transactionSigners: chainConfigs.map((chainConfig) => ({
          name: chainConfig.name,
          ...credentials(KEY_ROLE_ENUM.ProcessorSigner),
        })),
        indexonly: agentConfig.processor?.indexOnly || [],
        s3BucketName: agentConfig.processor?.s3Bucket || '',
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
  homeChainName: ChainName,
  role: KEY_ROLE_ENUM,
  agentConfig: AgentConfig,
  chainConfigs: ChainConfig[],
) {
  const valueDict = await helmValuesForChain(homeChainName, agentConfig, chainConfigs);
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
    const gcpKeys = await fetchAgentGCPKeys(agentConfig.environment, homeChainName);
    // Signer keys
    Object.keys(chainConfigs).forEach((network) => {
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
          gcpKeys[homeChainName + '-' + KEY_ROLE_ENUM.UpdaterAttestation].privateKey,
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
    Object.keys(chainConfigs).forEach((network) => {
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

    // Updater attestation key
    if (role.startsWith('updater')) {
      const key = new AgentAwsKey(agentConfig, role, homeChainName);
      envVars.push(`OPT_BASE_UPDATER_TYPE=aws`);
      envVars.push(
        `OPT_BASE_UPDATER_ID=${key.credentialsAsHelmValue.aws.keyId}`,
      );
      envVars.push(
        `OPT_BASE_UPDATER_REGION=${key.credentialsAsHelmValue.aws.region}`,
      );
    }
  }

  return envVars;
}

export async function runAgentHelmCommand(
  action: HelmCommand,
  agentConfig: AgentConfig,
  homeChainConfig: ChainConfig,
  chainConfigs: ChainConfig[],
) {
  const valueDict = await helmValuesForChain(
    homeChainConfig.name,
    agentConfig,
    chainConfigs,
  );
  const values = helmifyValues(valueDict);
  return execCmd(
    `helm ${action} ${
      homeChainConfig.name
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
  chainConfigs: ChainConfig[],
) {
  // It's ok to use pick an arbitrary chain here since we are only grabbing the signers
  const gcpKeys = await fetchAgentGCPKeys(
    agentConfig.environment,
    chainConfigs[0].name,
  );
  const bankKey = gcpKeys[KEY_ROLE_ENUM.Bank];
  const config = {
    networks: Object.fromEntries(chainConfigs.map((chainConfig) => {
      return [
        chainConfig.name,
        {
          endpoint: chainConfig.json.rpc,
          bank: {
            signer: ensure0x(bankKey.privateKey),
            address: bankKey.address,
          },
          threshold: 200000000000000000,
        },
      ];
    })),
    homes: Object.fromEntries(chainConfigs.map((chainConfig) => {
      return [
        chainConfig.name,
        {
          replicas: chainConfigs.map((c) => c.name),
          addresses: Object.fromEntries(
            KEY_ROLES.filter((_) => _.endsWith('signer')).map((role) => [
              role,
              gcpKeys[role].address,
            ]),
          ),
        },
      ];
    })),
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
