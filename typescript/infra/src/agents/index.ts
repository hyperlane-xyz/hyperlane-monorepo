import { AgentConnectionType, ChainName } from '@hyperlane-xyz/sdk';
import { utils } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts';
import { AgentConfig, DeployEnvironment } from '../config';
import { ChainAgentConfig, CheckpointSyncerType } from '../config/agent';
import { fetchGCPSecret } from '../utils/gcloud';
import {
  HelmCommand,
  buildHelmChartDependencies,
  helmifyValues,
} from '../utils/helm';
import { execCmd } from '../utils/utils';

import { keyIdentifier } from './agent';
import { AgentAwsUser, ValidatorAgentAwsUser } from './aws';
import { AgentAwsKey } from './aws/key';
import { AgentGCPKey } from './gcp';
import { fetchKeysForChain } from './key-utils';
import { KEY_ROLE_ENUM } from './roles';

const HELM_CHART_PATH = '../../rust/helm/hyperlane-agent/';

export async function runAgentHelmCommand(
  action: HelmCommand,
  agentConfig: AgentConfig,
  originChainName: ChainName,
): Promise<void> {
  // TODO: how is this function running for the relayer and validator? We need to make it only run for one or the other.

  const helmReleaseName = getHelmReleaseName(agentConfig, originChainName);
  const namespace = `--namespace ${agentConfig.namespace}`;

  if (action === HelmCommand.Remove) {
    const cmd = ['helm', action, helmReleaseName, namespace];
    await execCmd(cmd.join(' '), {}, false, true);
    return;
  }

  const valueDict = await helmValuesForChain(agentConfig, originChainName);
  const values = helmifyValues(valueDict);

  if (action === HelmCommand.InstallOrUpgrade) {
    // Delete secrets to avoid them being stale
    const cmd = [
      'kubectl',
      'delete',
      'secrets',
      namespace,
      '--selector',
      `app.kubernetes.io/instance=${helmReleaseName}`,
    ];
    try {
      await execCmd(cmd.join(' '), {}, false, false);
    } catch (e) {
      console.error(e);
    }
  }

  // Build the chart dependencies
  await buildHelmChartDependencies(HELM_CHART_PATH);

  const cmd = [
    'helm',
    action,
    helmReleaseName,
    HELM_CHART_PATH,
    '--create-namespace',
    namespace,
    ...values,
  ];
  if (action === HelmCommand.UpgradeDiff) {
    cmd.push(
      `| kubectl diff ${namespace} --field-manager="Go-http-client" -f - || true`,
    );
  }
  await execCmd(cmd.join(' '), {}, false, true);
}

export async function getAgentEnvVars(
  originChainName: ChainName,
  role: KEY_ROLE_ENUM,
  agentConfig: AgentConfig,
  index?: number,
) {
  const chainNames = agentConfig.contextChainNames;
  if (role === KEY_ROLE_ENUM.Validator && index === undefined) {
    throw Error('Expected index for validator role');
  }

  const valueDict = await helmValuesForChain(originChainName, agentConfig);
  let envVars: string[] = [];
  const rpcEndpoints = await getSecretRpcEndpoints(agentConfig);
  valueDict.hyperlane.chains.forEach((chain: any) => {
    envVars.push(
      `HYP_BASE_CHAINS_${chain.name.toUpperCase()}_CONNECTION_URL=${
        rpcEndpoints[chain.name]
      }`,
    );
  });

  // Base vars from config map
  envVars.push(`HYP_BASE_METRICS=9090`);
  envVars.push(`HYP_BASE_TRACING_LEVEL=info`);
  envVars.push(
    `HYP_BASE_DB=/tmp/${agentConfig.runEnv}-${role}-${originChainName}${
      role === KEY_ROLE_ENUM.Validator ? `-${index}` : ''
    }-db`,
  );

  // GCP keys
  if (!agentConfig.aws) {
    const gcpKeys = (await fetchKeysForChain(
      agentConfig,
      originChainName,
    )) as Record<string, AgentGCPKey>;

    const keyId = keyIdentifier(
      agentConfig.runEnv,
      agentConfig.context,
      role,
      originChainName,
      index,
    );

    // Only the relayer needs to sign txs
    if (role === KEY_ROLE_ENUM.Relayer) {
      chainNames.forEach((name) => {
        envVars.push(
          `HYP_BASE_CHAINS_${name.toUpperCase()}_SIGNER_KEY=${utils.strip0x(
            gcpKeys[keyId].privateKey,
          )}`,
        );
        envVars.push(
          `HYP_BASE_CHAINS_${name.toUpperCase()}_SIGNER_TYPE=hexKey`,
        );
      });
    } else if (role === KEY_ROLE_ENUM.Validator) {
      const privateKey = gcpKeys[keyId].privateKey;

      envVars.push(
        `HYP_VALIDATOR_VALIDATOR_KEY=${utils.strip0x(privateKey)}`,
        `HYP_VALIDATOR_VALIDATOR_TYPE=hexKey`,
      );
    }
  } else {
    // AWS keys

    let user: AgentAwsUser;

    if (role === KEY_ROLE_ENUM.Validator && agentConfig.validators) {
      const checkpointSyncer =
        agentConfig.validators[originChainName].validators[index!]
          .checkpointSyncer;
      if (checkpointSyncer.type !== CheckpointSyncerType.S3) {
        throw Error(
          'Expected S3 checkpoint syncer for validator with AWS keys',
        );
      }
      user = new ValidatorAgentAwsUser(
        agentConfig.runEnv,
        agentConfig.context,
        originChainName,
        index!,
        checkpointSyncer.region,
        checkpointSyncer.bucket,
      );
    } else {
      user = new AgentAwsUser(
        agentConfig.runEnv,
        agentConfig.context,
        role,
        agentConfig.aws!.region,
        originChainName,
      );
    }

    const accessKeys = await user.getAccessKeys();

    envVars.push(`AWS_ACCESS_KEY_ID=${accessKeys.accessKeyId}`);
    envVars.push(`AWS_SECRET_ACCESS_KEY=${accessKeys.secretAccessKey}`);

    // Only the relayer needs to sign txs
    if (role === KEY_ROLE_ENUM.Relayer) {
      chainNames.forEach((chainName) => {
        const key = new AgentAwsKey(agentConfig, role, originChainName);
        envVars = envVars.concat(
          configEnvVars(
            key.keyConfig,
            'BASE',
            `CHAINS_${chainName.toUpperCase()}_SIGNER_`,
          ),
        );
      });
    }
  }

  switch (role) {
    case KEY_ROLE_ENUM.Validator:
      if (valueDict.hyperlane.validator.configs) {
        envVars = envVars.concat(
          configEnvVars(
            valueDict.hyperlane.validator.configs[index!],
            KEY_ROLE_ENUM.Validator,
          ),
        );
      }
      break;
    case KEY_ROLE_ENUM.Relayer:
      if (valueDict.hyperlane.relayer.config) {
        envVars = envVars.concat(
          configEnvVars(
            valueDict.hyperlane.relayer.config,
            KEY_ROLE_ENUM.Relayer,
          ),
        );
      }
      break;
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
  quorum = false,
) {
  return fetchGCPSecret(
    `${environment}-rpc-endpoint${quorum ? 's' : ''}-${chainName}`,
    quorum,
  );
}

export async function getSecretDeployerKey(
  environment: DeployEnvironment,
  context: Contexts,
  chainName: ChainName,
) {
  const key = new AgentGCPKey(
    environment,
    context,
    KEY_ROLE_ENUM.Deployer,
    chainName,
  );
  await key.fetch();
  return key.privateKey;
}

export async function doesAgentReleaseExist(
  agentConfig: AgentConfig,
  originChainName: ChainName,
) {
  try {
    await execCmd(
      `helm status ${getHelmReleaseName(
        agentConfig,
        originChainName,
      )} --namespace ${agentConfig.namespace}`,
      {},
      false,
      false,
    );
    return true;
  } catch (error) {
    return false;
  }
}

async function helmValuesForChain(
  agentConfig: AgentConfig,
  chainName: ChainName,
) {
  const chainAgentConfig = new ChainAgentConfig(agentConfig, chainName);

  // By default, if a context only enables a subset of chains, the
  // connection url (or urls, when HttpQuorum is used) are not fetched
  // from GCP secret manager. For Http/Ws, the `url` param is expected,
  // which is set by default to "" in the agent json configs. For HttpQuorum,
  // no default is present in those configs, so we make sure to pass in urls
  // as "" to avoid startup configuration issues.
  let baseConnectionConfig: Record<string, string> = {
    type: agentConfig.connectionType,
  };
  if (baseConnectionConfig.type == AgentConnectionType.HttpQuorum) {
    baseConnectionConfig = {
      ...baseConnectionConfig,
      urls: '',
    };
  } else {
    baseConnectionConfig = {
      ...baseConnectionConfig,
      url: '',
    };
  }

  const signers = await chainAgentConfig.signers();

  return {
    image: {
      repository: agentConfig.docker.repo,
      tag: agentConfig.docker.tag,
    },
    hyperlane: {
      runEnv: agentConfig.runEnv,
      context: agentConfig.context,
      aws: !!agentConfig.aws,
      chains: agentConfig.environmentChainNames.map((envChainName) => ({
        name: envChainName,
        disabled: !agentConfig.contextChainNames.includes(envChainName),
        connection: baseConnectionConfig,
      })),
      // Only the relayer has the signers on the chains config object
      relayerChains: agentConfig.environmentChainNames.map((envChainName) => ({
        name: envChainName,
        signer: signers[envChainName],
      })),
      /// TODO: this is how we specify what agent is being deployed
      scraper: {
        enabled: false,
      },
      validator: {
        enabled: chainAgentConfig.validatorEnabled,
        configs: await chainAgentConfig.validatorConfigs(),
      },
      relayer: {
        enabled: chainAgentConfig.relayerEnabled,
        aws: await chainAgentConfig.relayerRequiresAwsCredentials(),
        config: chainAgentConfig.relayerConfig,
      },
    },
  };
}

// Recursively converts a config object into environment variables than can
// be parsed by rust. For example, a config of { foo: { bar: { baz: 420 }, boo: 421 } } will
// be: HYP_FOO_BAR_BAZ=420 and HYP_FOO_BOO=421
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
        `HYP_${role.toUpperCase()}_${key_name_prefix}${key.toUpperCase()}=${
          config[key]
        }`,
      );
    }
  }
  return envVars;
}

async function getSecretRpcEndpoints(agentConfig: AgentConfig, quorum = false) {
  const environment = agentConfig.runEnv;
  return Object.fromEntries(
    agentConfig.contextChainNames.map((chainName) => [
      chainName,
      getSecretRpcEndpoint(environment, chainName, quorum),
    ]),
  );
}

function getHelmReleaseName(
  agentConfig: AgentConfig,
  originChainName?: ChainName,
): string {
  // For backward compatibility reasons, don't include the context
  // in the name of the helm release if the context is the default "hyperlane"

  const nameParts = [originChainName ?? 'omniscient'];
  if (agentConfig.context !== 'hyperlane') {
    nameParts.push(agentConfig.context);
  }
  return nameParts.join('-');
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
