import { ChainName } from '@hyperlane-xyz/sdk';

import { AgentConfig } from '../config';
import { ConnectionType } from '../config/agent';
import {
  HelmCommand,
  buildHelmChartDependencies,
  helmifyValues,
} from '../utils/helm';
import { execCmd } from '../utils/utils';

const helmChartPath = '../../rust/helm/scraper/';

export async function runScraperHelmCommand<Chain extends ChainName>(
  action: HelmCommand,
  agentConfig: AgentConfig<Chain>,
) {
  const values = await scraperHelmValues(agentConfig);

  const extraPipe =
    action === HelmCommand.UpgradeDiff
      ? ` | kubectl diff -n ${agentConfig.namespace} --field-manager="Go-http-client" -f - || true`
      : '';

  const helmReleaseName = getScraperHelmReleaseName(agentConfig);

  if (action === HelmCommand.InstallOrUpgrade) {
    // Delete secrets to avoid them being stale
    try {
      await execCmd(
        `kubectl delete secrets --namespace ${agentConfig.namespace} --selector app.kubernetes.io/instance=${helmReleaseName}`,
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
    `helm ${action} ${helmReleaseName} ${helmChartPath} --create-namespace --namespace ${
      agentConfig.namespace
    } ${values.join(' ')} ${extraPipe}`,
    {},
    false,
    true,
  );
}

async function scraperHelmValues<Chain extends ChainName>(
  agentConfig: AgentConfig<Chain>,
) {
  // By default, if a context only enables a subset of chains, the
  // connection url (or urls, when HttpQuorum is used) are not fetched
  // from GCP secret manager. For Http/Ws, the `url` param is expected,
  // which is set by default to "" in the agent json configs. For HttpQuorum,
  // no default is present in those configs, so we make sure to pass in urls
  // as "" to avoid startup configuration issues.
  let baseConnectionConfig: Record<string, string> = {
    type: agentConfig.connectionType,
  };
  if (baseConnectionConfig.type == ConnectionType.HttpQuorum) {
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

  const chains = agentConfig.environmentChainNames.map((name) => ({
    name,
    disabled: !agentConfig.contextChainNames.includes(name),
    connection: baseConnectionConfig,
  }));

  const valueDict = {
    abacus: {
      runEnv: agentConfig.environment,
      context: agentConfig.context,
      // Expects an array
      inboxChains: chains,
      outboxChains: chains,
    },
    image: {
      repository: agentConfig.docker.repo,
      tag: agentConfig.docker.tag,
    },
  };
  return helmifyValues(valueDict);
}

function getScraperHelmReleaseName<Chain extends ChainName>(
  agentConfig: AgentConfig<Chain>,
) {
  return `${agentConfig.context}-scraper`;
}
