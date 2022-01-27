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
  processorIndexOnly?: string[];
  processorS3Bucket?: string;
  dockerImageRepo: string;
  dockerImageTag: string;
}

export interface AgentChainConfigs {
  [name: string]: ChainJson;
}

// This is the type for how the keys are persisted in GCP
interface SecretManagerPersistedKeys {
  privateKey: string;
  address: string;
  role: string;
  environment: string;
  // Exists if key is an attestation key
  // TODO: Add this to the type
  chainName?: string;
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

export async function deleteAgentGCPKeys(
  environment: string,
  chainNames: string[],
) {
  await Promise.all(
    KEY_ROLES.map(async (role) => {
      if (role.endsWith('attestation')) {
        await Promise.all(
          chainNames.map((chainName) =>
            execCmd(
              `gcloud secrets delete optics-key-${environment}-${chainName}-${role} --quiet`,
            ),
          ),
        );
      } else {
        await execCmd(
          `gcloud secrets delete optics-key-${environment}-${role} --quiet`,
        );
      }
    }),
  );
  await execCmd(
    `gcloud secrets delete optics-key-${environment}-addresses --quiet`,
  );
}

async function createAgentGCPKey(
  environment: string,
  role: string,
  chainName: string,
  rotate = false,
) {
  const wallet = Wallet.createRandom();
  const address = await wallet.getAddress();
  const isAttestationKey = role.endsWith('attestation');
  const tempFileName = isAttestationKey
    ? `optics-key-${environment}-${chainName}-${role}.txt`
    : `optics-key-${environment}-${role}.txt`;
  const gcpKeyIdentifier = isAttestationKey
    ? `optics-key-${environment}-${chainName}-${role}`
    : `optics-key-${environment}-${role}`;

  let labels = `environment=${environment},role=${role}`;
  if (isAttestationKey) labels += `,chain=${chainName}`;

  await writeFile(
    tempFileName,
    JSON.stringify({
      role,
      environment,
      privateKey: wallet.privateKey,
      address,
      ...include(isAttestationKey, { chainName }),
    }),
  );

  if (rotate) {
    await execCmd(
      `gcloud secrets versions add ${gcpKeyIdentifier} --data-file=${tempFileName}`,
    );
  } else {
    await execCmd(
      `gcloud secrets create ${gcpKeyIdentifier} --data-file=${tempFileName} --replication-policy=automatic --labels=${labels}`,
    );
  }

  await rm(tempFileName);
  return {
    role,
    environment,
    address,
    chainName,
  };
}

export function persistKeyAsAddress(key: {
  role: string;
  environment: string;
  address: string;
  chainName: string;
}) {
  const isAttestationKey = key.role.endsWith('attestation');

  return {
    role: isAttestationKey ? `${key.chainName}-${key.role}` : key.role,
    address: key.address,
  };
}

export async function rotateGCPKey(
  environment: string,
  role: string,
  chainName: string,
) {
  const newKey = await createAgentGCPKey(environment, role, chainName, true);

  const [addressesRaw] = await execCmd(
    `gcloud secrets versions access latest --secret optics-key-${environment}-addresses`,
  );
  const addresses = JSON.parse(addressesRaw);
  const filteredAddresses = addresses.filter((_: any) => {
    const isAttestationKey = role.endsWith('attestation')
    const matchingRole = isAttestationKey ? `${chainName}-${role}` : role
    return _.role !== matchingRole
  });

  filteredAddresses.push(persistKeyAsAddress(newKey));

  await writeFile(
    `optics-key-${environment}-addresses.txt`,
    JSON.stringify(filteredAddresses),
  );
  await execCmd(
    `gcloud secrets versions add optics-key-${environment}-addresses --data-file=optics-key-${environment}-addresses.txt`,
  );
  await rm(`optics-key-${environment}-addresses.txt`);

  return newKey;
}

// When GCP managed dev agent keys were first introduced, all chains shared the same attestation keys. This function splits those out logically (while keeping the same keys), so that individual keys can be rotated
export async function splitAgentGCPKeys(
  environment: string,
  chainNames: string[],
) {
  const keys = await getLegacyAgentGCPKeys(environment);
  for (const chainName of chainNames) {
    for (const key of Object.values(keys)) {
      if (key.role.endsWith('attestation')) {
        await writeFile(
          `optics-key-${environment}-${chainName}-${key.role}.txt`,
          JSON.stringify({
            role: key.role,
            chainName,
            environment,
            privateKey: key.privateKey,
            address: key.address,
          }),
        );
        await execCmd(
          `gcloud secrets create optics-key-${environment}-${chainName}-${key.role} --data-file=optics-key-${environment}-${chainName}-${key.role}.txt --replication-policy=automatic --labels=environment=${environment},role=${key.role},chain=${chainName}`,
        );
        await rm(`optics-key-${environment}-${chainName}-${key.role}.txt`);
      }
    }
  }
}

export async function createAgentGCPKeys(
  environment: string,
  chainNames: string[],
) {
  const keys = await Promise.all(
    KEY_ROLES.flatMap((role) => {
      const isAttestationKey = role.endsWith('attestation');

      if (isAttestationKey) {
        return chainNames.map((chainName) =>
          createAgentGCPKey(environment, role, chainName),
        );
      } else {
        // Chain name doesnt matter for non attestation keys
        return [createAgentGCPKey(environment, role, 'any')];
      }
    }),
  );

  await writeFile(
    `optics-key-${environment}-addresses.txt`,
    JSON.stringify(
      keys.map(persistKeyAsAddress),
    ),
  );
  await execCmd(
    `gcloud secrets create optics-key-${environment}-addresses --data-file=optics-key-${environment}-addresses.txt --replication-policy=automatic --labels=environment=${environment}`,
  );
  await rm(`optics-key-${environment}-addresses.txt`);
}

// TODO: Remove this once legacy keys have been removed
async function getLegacyAgentGCPKey(environment: string, role: string) {
  const [secretRaw] = await execCmd(
    `gcloud secrets versions access latest --secret optics-key-${environment}-${role}`,
  );
  const secret: SecretManagerPersistedKeys = JSON.parse(secretRaw);
  return [role, secret] as [string, SecretManagerPersistedKeys];
}

// TODO: remove this once legacy keys have been migrated
async function getLegacyAgentGCPKeys(environment: string) {
  const secrets = await Promise.all(
    KEY_ROLES.map((role) => getLegacyAgentGCPKey(environment, role)),
  );
  return Object.fromEntries(secrets);
}

async function getAgentGCPKey(
  environment: string,
  role: string,
  chainName: string,
) {
  const isAttestationKey = role.endsWith('attestation');
  const gcpKeyIdentifier = isAttestationKey
    ? `optics-key-${environment}-${chainName}-${role}`
    : `optics-key-${environment}-${role}`;
  const [secretRaw] = await execCmd(
    `gcloud secrets versions access latest --secret ${gcpKeyIdentifier}`,
  );
  const secret: SecretManagerPersistedKeys = JSON.parse(secretRaw);
  const keyIdentifier = isAttestationKey
    ? `${secret.chainName!}-${secret.role}`
    : secret.role;
  return [keyIdentifier, secret] as [string, SecretManagerPersistedKeys];
}

// This function returns all the GCP keys for a given home chain in a dictionary where the key is either the role or `${chainName}-${role}` in the case of attestation keys
async function getAgentGCPKeys(environment: string, chainName: string) {
  const secrets = await Promise.all(
    KEY_ROLES.map((role) => getAgentGCPKey(environment, role, chainName)),
  );
  return Object.fromEntries(secrets);
}

// Modifies a Chain configuration with the deployer key pulled from GCP
export async function addDeployerGCPKey(environment: string, chain: Chain) {
  const [deployerSecretRaw] = await execCmd(
    `gcloud secrets versions access latest --secret optics-key-${environment}-deployer`,
  );
  const deployerSecret = JSON.parse(deployerSecretRaw).privateKey;
  return replaceDeployer(chain, strip0x(deployerSecret));
}

// Modifies a Core configuration with the relevant watcher/updater addresses pulled from GCP
export async function addAgentGCPAddresses(
  environment: string,
  chain: Chain,
  config: CoreConfig,
): Promise<CoreConfig> {
  const [addressesRaw] = await execCmd(
    `gcloud secrets versions access latest --secret optics-key-${environment}-addresses`,
  );
  const addresses = JSON.parse(addressesRaw);
  const watcher = addresses.find(
    (_: any) => _.role === `${chain.name}-watcher-attestation`,
  ).address;
  const updater = addresses.find(
    (_: any) => _.role === `${chain.name}-updater-attestation`,
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
      if (role.endsWith('attestation')) {
        return { hexKey: strip0x(gcpKeys![`${chainName}-${role}`].privateKey) };
      }
      return { hexKey: strip0x(gcpKeys![role].privateKey) };
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
  const gcpKeys = await getAgentGCPKeys(agentConfig.environment, configs[0].name);
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
