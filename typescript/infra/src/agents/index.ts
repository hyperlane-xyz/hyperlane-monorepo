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

const helmChartPath = '../../rust/helm/hyperlane-agent/';

async function helmValuesForChain(
  chainName: ChainName,
  agentConfig: AgentConfig,
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

export async function getAgentEnvVars(
  outboxChainName: ChainName,
  role: KEY_ROLE_ENUM,
  agentConfig: AgentConfig,
  index?: number,
) {
  const chainNames = agentConfig.contextChainNames;
  if (role === KEY_ROLE_ENUM.Validator && index === undefined) {
    throw Error('Expected index for validator role');
  }

  const valueDict = await helmValuesForChain(outboxChainName, agentConfig);
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
    `HYP_BASE_DB=/tmp/${agentConfig.runEnv}-${role}-${outboxChainName}${
      role === KEY_ROLE_ENUM.Validator ? `-${index}` : ''
    }-db`,
  );

  // GCP keys
  if (!agentConfig.aws) {
    const gcpKeys = (await fetchKeysForChain(
      agentConfig,
      outboxChainName,
    )) as Record<string, AgentGCPKey>;

    const keyId = keyIdentifier(
      agentConfig.runEnv,
      agentConfig.context,
      role,
      outboxChainName,
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
        agentConfig.validators[outboxChainName].validators[index!]
          .checkpointSyncer;
      if (checkpointSyncer.type !== CheckpointSyncerType.S3) {
        throw Error(
          'Expected S3 checkpoint syncer for validator with AWS keys',
        );
      }
      user = new ValidatorAgentAwsUser(
        agentConfig.runEnv,
        agentConfig.context,
        outboxChainName,
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
        outboxChainName,
      );
    }

    const accessKeys = await user.getAccessKeys();

    envVars.push(`AWS_ACCESS_KEY_ID=${accessKeys.accessKeyId}`);
    envVars.push(`AWS_SECRET_ACCESS_KEY=${accessKeys.secretAccessKey}`);

    // Only the relayer needs to sign txs
    if (role === KEY_ROLE_ENUM.Relayer) {
      chainNames.forEach((chainName) => {
        const key = new AgentAwsKey(agentConfig, role, outboxChainName);
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

async function getSecretRpcEndpoints(agentConfig: AgentConfig, quorum = false) {
  const environment = agentConfig.runEnv;
  return Object.fromEntries(
    agentConfig.contextChainNames.map((chainName) => [
      chainName,
      getSecretRpcEndpoint(environment, chainName, quorum),
    ]),
  );
}

export async function doesAgentReleaseExist(
  agentConfig: AgentConfig,
  outboxChainName: ChainName,
) {
  try {
    await execCmd(
      `helm status ${getHelmReleaseName(
        outboxChainName,
        agentConfig,
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

export async function runAgentHelmCommand(
  action: HelmCommand,
  agentConfig: AgentConfig,
  outboxChainName: ChainName,
) {
  if (action === HelmCommand.Remove) {
    return execCmd(
      `helm ${action} ${getHelmReleaseName(
        outboxChainName,
        agentConfig,
      )} --namespace ${agentConfig.namespace}`,
      {},
      false,
      true,
    );
  }

  const valueDict = await helmValuesForChain(outboxChainName, agentConfig);
  const values = helmifyValues(valueDict);

  const extraPipe =
    action === HelmCommand.UpgradeDiff
      ? ` | kubectl diff -n ${agentConfig.namespace} --field-manager="Go-http-client" -f - || true`
      : '';

  if (action === HelmCommand.InstallOrUpgrade) {
    // Delete secrets to avoid them being stale
    try {
      await execCmd(
        `kubectl delete secrets --namespace ${
          agentConfig.namespace
        } --selector app.kubernetes.io/instance=${getHelmReleaseName(
          outboxChainName,
          agentConfig,
        )}`,
        {},
        false,
        false,
      );
    } catch (e) {
      console.error(e);
    }
  }

  // Build the chart dependencies
  await buildHelmChartDependencies(helmChartPath);

  await execCmd(
    `helm ${action} ${getHelmReleaseName(
      outboxChainName,
      agentConfig,
    )} ${helmChartPath} --create-namespace --namespace ${
      agentConfig.namespace
    } ${values.join(' ')} ${extraPipe}`,
    {},
    false,
    true,
  );

  return;
}

function getHelmReleaseName(
  outboxChainName: ChainName,
  agentConfig: AgentConfig,
): string {
  // For backward compatibility reasons, don't include the context
  // in the name of the helm release if the context is the default "hyperlane"
  if (agentConfig.context === 'hyperlane') {
    return outboxChainName;
  }
  return `${outboxChainName}-${agentConfig.context}`;
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
