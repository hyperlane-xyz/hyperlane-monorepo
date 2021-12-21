import { Wallet } from '@ethersproject/wallet';
import { rm, writeFile } from 'fs/promises';
import { Chain, ChainJson, replaceDeployer } from './chain';
import { CoreConfig } from './core/CoreDeploy';
import { execCmd, strip0x } from './utils';

export interface AgentConfig {
  namespace: string;
  runEnv: string;
  awsRegion: string;
  awsKeyId: string;
  awsSecretAccessKey: string;
  dockerImageRepo: string;
  dockerImageTag: string;
}

export interface AgentChainsConfig {
  [name: string]: ChainJson;
}

export const KEY_ROLES = [
  'updater-attestation',
  'updater-signer',
  'processor-signer',
  'relayer-signer',
  'watcher-attestation',
  'watcher-signer',
  'deployer',
  'bank'
];

export async function deleteKeysInGCP(environment: string) {
  await Promise.all(
    KEY_ROLES.map(async (role) => {
      await execCmd(`gcloud secrets delete optics-key-${environment}-${role} --quiet`);
    }),
  );
  await execCmd(`gcloud secrets delete optics-key-${environment}-addresses --quiet`);
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

  await writeFile(`optics-key-${environment}-addresses.txt`, JSON.stringify(keys.map(_ => ({ role: _.role, address: _.address }))))
  await execCmd(
    `gcloud secrets create optics-key-${environment}-addresses --data-file=optics-key-${environment}-addresses.txt --replication-policy=automatic --labels=environment=${environment}`,
  );
  await rm(`optics-key-${environment}-addresses.txt`);
}

export async function augmentChain(environment: string, chain: Chain) {
  const [deployerSecretRaw] = await execCmd(`gcloud secrets versions access latest --secret optics-key-${environment}-deployer`)
  const deployerSecret = JSON.parse(deployerSecretRaw).privateKey
  return replaceDeployer(chain, strip0x(deployerSecret))
}

export async function augmentCoreConfig(environment: string, config: CoreConfig) {
  const [addressesRaw] = await execCmd(`gcloud secrets versions access latest --secret optics-key-${environment}-addresses`) 
  const addresses = JSON.parse(addressesRaw)
  const watcher = addresses.find((_: any) => _.role === 'watcher-attestation').address
  const updater = addresses.find((_: any) => _.role === 'updater-attestation').address
  const deployer = addresses.find((_: any) => _.role === 'deployer').address
  return {
    ...config,
    updater: updater,
    recoveryManager: deployer,
    watchers: [watcher]
  }
}

function valuesForHome(home: string, agentConfig: AgentConfig, configs: any) {
  if (
    !agentConfig.awsRegion ||
    !agentConfig.awsKeyId ||
    !agentConfig.awsSecretAccessKey
  ) {
    throw new Error('Some AgentConfig aws values are missing');
  }
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
      aws: {
        accessKeyId: agentConfig.awsKeyId,
        secretAccessKey: agentConfig.awsSecretAccessKey,
      },
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
          aws: {
            // Just on staging
            keyId: `alias/${agentConfig.runEnv}-${home}-updater-attestation`,
            region: agentConfig.awsRegion,
          },
        })),
        attestationSigner: {
          aws: {
            keyId: `alias/${agentConfig.runEnv}-${home}-updater-signer`,
            region: agentConfig.awsRegion,
          },
        },
      },
      relayer: {
        transactionSigners: Object.keys(configs).map((chain) => ({
          name: configs[chain].name,
          aws: {
            // Just on staging
            keyId: `alias/${agentConfig.runEnv}-${home}-relayer-signer`,
            region: agentConfig.awsRegion,
          },
        })),
      },
      processor: {
        transactionSigners: Object.keys(configs).map((chain) => ({
          name: configs[chain].name,
          aws: {
            // Just on staging
            keyId: `alias/${agentConfig.runEnv}-${home}-processor-signer`,
            region: agentConfig.awsRegion,
          },
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

export function runHelmCommand(
  action: 'install' | 'upgrade',
  agentConfig: AgentConfig,
  homeConfig: ChainJson,
  configs: AgentChainsConfig,
) {
  const valueDict = valuesForHome(homeConfig.name, agentConfig, configs);
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
