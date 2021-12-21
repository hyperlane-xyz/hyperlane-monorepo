import { Wallet } from '@ethersproject/wallet';
import { rm, writeFile } from 'fs/promises';
import { Chain, ChainJson, replaceDeployer } from './chain';
import { CoreConfig } from './core/CoreDeploy';
import { ensure0x, execCmd, strip0x } from './utils';

export interface AgentConfig {
  environment: string;
  namespace: string;
  runEnv: string;
  awsRegion?: string;
  awsKeyId?: string;
  awsSecretAccessKey?: string;
  dockerImageRepo: string;
  dockerImageTag: string;
}

export interface AgentChainsConfig {
  [name: string]: ChainJson;
}

interface SecretManagerPersistedKeys {
  privateKey: string;
  address: string;
  role: string;
  environment: string;
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

export async function deleteKeysInGCP(environment: string) {
  await Promise.all(
    KEY_ROLES.map(async (role) => {
      await execCmd(
        `gcloud secrets delete optics-key-${environment}-${role} --quiet`,
      );
    }),
  );
  await execCmd(
    `gcloud secrets delete optics-key-${environment}-addresses --quiet`,
  );
}

export async function createKeysInGCP(environment: string) {
  const keys = await Promise.all(
    KEY_ROLES.map(async (role) => {
      const wallet = Wallet.createRandom();
      const address = await wallet.getAddress();
      await writeFile(
        `optics-key-${environment}-${role}.txt`,
        JSON.stringify({
          role,
          environment,
          privateKey: wallet.privateKey,
          address,
        }),
      );
      await execCmd(
        `gcloud secrets create optics-key-${environment}-${role} --data-file=optics-key-${environment}-${role}.txt --replication-policy=automatic --labels=environment=${environment},role=${role}`,
      );
      await rm(`optics-key-${environment}-${role}.txt`);
      return {
        role,
        environment,
        address,
      };
    }),
  );

  await writeFile(
    `optics-key-${environment}-addresses.txt`,
    JSON.stringify(keys.map((_) => ({ role: _.role, address: _.address }))),
  );
  await execCmd(
    `gcloud secrets create optics-key-${environment}-addresses --data-file=optics-key-${environment}-addresses.txt --replication-policy=automatic --labels=environment=${environment}`,
  );
  await rm(`optics-key-${environment}-addresses.txt`);
}

async function getKeys(environment: string) {
  const secrets = await Promise.all(
    KEY_ROLES.map(async (role) => {
      const [secretRaw] = await execCmd(
        `gcloud secrets versions access latest --secret optics-key-${environment}-${role}`,
      );
      const secret: SecretManagerPersistedKeys = JSON.parse(secretRaw);
      return [role, secret] as [string, SecretManagerPersistedKeys];
    }),
  );
  return Object.fromEntries(secrets);
}

export async function augmentChain(environment: string, chain: Chain) {
  const [deployerSecretRaw] = await execCmd(
    `gcloud secrets versions access latest --secret optics-key-${environment}-deployer`,
  );
  const deployerSecret = JSON.parse(deployerSecretRaw).privateKey;
  return replaceDeployer(chain, strip0x(deployerSecret));
}

export async function augmentCoreConfig(
  environment: string,
  config: CoreConfig,
) {
  const [addressesRaw] = await execCmd(
    `gcloud secrets versions access latest --secret optics-key-${environment}-addresses`,
  );
  const addresses = JSON.parse(addressesRaw);
  const watcher = addresses.find(
    (_: any) => _.role === 'watcher-attestation',
  ).address;
  const updater = addresses.find(
    (_: any) => _.role === 'updater-attestation',
  ).address;
  const deployer = addresses.find((_: any) => _.role === 'deployer').address;
  return {
    ...config,
    updater: updater,
    recoveryManager: deployer,
    watchers: [watcher],
  };
}

function include(condition: boolean, data: any) {
  return condition ? data : {};
}

async function valuesForHome(
  home: string,
  agentConfig: AgentConfig,
  configs: any,
) {
  let gcpKeys: { [role: string]: SecretManagerPersistedKeys } | undefined =
    undefined;
  try {
    gcpKeys = await getKeys(agentConfig.environment);
  } catch (error) {
    if (
      !agentConfig.awsRegion ||
      !agentConfig.awsKeyId ||
      !agentConfig.awsSecretAccessKey
    ) {
      throw new Error('agents keys are neither in GCP nor in AWS');
    }
  }

  const credentials = (role: KEY_ROLE_ENUM) => {
    if (!!gcpKeys) {
      return { hexKey: strip0x(gcpKeys![role].privateKey) };
    } else {
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
          // Just on staging
          keyId: `alias/${agentConfig.runEnv}-${home}-${adjustedRole}`,
          region: agentConfig.awsRegion,
        },
      };
    }
  };

  return {
    image: {
      repository: agentConfig.dockerImageRepo,
      tag: agentConfig.dockerImageTag,
    },
    optics: {
      runEnv: agentConfig.runEnv,
      baseConfig: `${home}_config.json`,
      homeChain: {
        name: home,
        connectionUrl: configs[home].rpc,
      },
      ...include(!gcpKeys, {
        aws: {
          accessKeyId: agentConfig.awsKeyId,
          secretAccessKey: agentConfig.awsSecretAccessKey,
        },
      }),
      replicaChains: Object.keys(configs)
        .filter((_) => _ !== home)
        .map((replica) => {
          const replicaConfig = configs[replica];
          return {
            name: replica,
            connectionUrl: replicaConfig.rpc,
          };
        }),
      updater: {
        transactionSigners: Object.keys(configs).map((chain) => ({
          name: configs[chain].name,
          ...credentials(KEY_ROLE_ENUM.UpdaterSigner),
        })),
        attestationSigner: {
          ...credentials(KEY_ROLE_ENUM.UpdaterAttestation),
        },
      },
      relayer: {
        transactionSigners: Object.keys(configs).map((chain) => ({
          name: configs[chain].name,
          ...credentials(KEY_ROLE_ENUM.RelayerSigner),
        })),
      },
      processor: {
        transactionSigners: Object.keys(configs).map((chain) => ({
          name: configs[chain].name,
          ...credentials(KEY_ROLE_ENUM.ProcessorSigner),
        })),
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

export async function outputAgentEnvVars(
  home: string,
  role: KEY_ROLE_ENUM,
  agentConfig: AgentConfig,
  configs: AgentChainsConfig
) {
  const gcpKeys = await getKeys(agentConfig.environment)
  const valueDict = await valuesForHome(home, agentConfig, configs);

  const envVars: string[] = []

  // Base vars from config map
  envVars.push(`BASE_CONFIG=${valueDict.optics.baseConfig}`)
  envVars.push(`OPT_BASE_HOME_CONNECTION_URL=${valueDict.optics.homeChain.connectionUrl}`)
  envVars.push(`RUN_ENV=${agentConfig.runEnv}`)
  valueDict.optics.replicaChains.forEach((replicaChain: any) => {
    envVars.push(`OPT_BASE_REPLICAS_${replicaChain.name.toUpperCase()}_CONNECTION_URL=${replicaChain.connectionUrl}`)
  })

  // Signer key
  Object.keys(configs).forEach(network => {
    envVars.push(`OPT_BASE_SIGNERS_${network.toUpperCase()}_KEY=${strip0x(gcpKeys[role].privateKey)}`)
  })

  if (role.startsWith('updater')) {
    envVars.push(`OPT_BASE_UPDATER_KEY=${strip0x(gcpKeys[KEY_ROLE_ENUM.UpdaterAttestation].privateKey)}`)
  }
  return envVars
}

export async function runAgentHelmCommand(
  action: 'install' | 'upgrade',
  agentConfig: AgentConfig,
  homeConfig: ChainJson,
  configs: AgentChainsConfig,
) {
  const valueDict = await valuesForHome(homeConfig.name, agentConfig, configs);
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
  action: 'install' | 'upgrade',
  agentConfig: AgentConfig,
  configs: AgentChainsConfig,
) {
  const gcpKeys = await getKeys(agentConfig.environment);
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
          threshold: 20000000000000000
        },
      ];
    }),
    homes: mapPairs(configs, (home, chain) => {
      return [home, {
        replicas: Object.keys(configs),
        addresses: Object.fromEntries(KEY_ROLES.filter(_ => _.endsWith('signer')).map(role => [role,gcpKeys[role].address]))
      }]
    })

  };

  await writeFile(
    `config.json`,
    JSON.stringify(config),
  );

  await execCmd(
    `helm ${action} keymaster-${
      agentConfig.environment
    } ../../tools/keymaster/helm/keymaster/ --namespace ${
      agentConfig.namespace
    } --set-file keymaster.config=config.json`,
    {},
    false,
    true,
  );

  await rm('config.json')
    return
}

function mapPairs<V, R>(
  dict: { [k: string]: V },
  f: (key: string, value: V) => [string, R],
) {
  return Object.fromEntries(Object.keys(dict).map((key) => f(key, dict[key])));
}
