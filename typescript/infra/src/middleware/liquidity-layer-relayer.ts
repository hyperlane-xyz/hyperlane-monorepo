import { AgentContextConfig } from '../config/agent/agent.js';
import { EnvironmentConfig } from '../config/environment.js';
import { LiquidityLayerRelayerConfig } from '../config/middleware.js';
import { HelmCommand, helmifyValues } from '../utils/helm.js';
import { execCmd } from '../utils/utils.js';

export async function runLiquidityLayerRelayerHelmCommand(
  helmCommand: HelmCommand,
  agentConfig: AgentContextConfig,
  relayerConfig: LiquidityLayerRelayerConfig,
) {
  const values = getLiquidityLayerRelayerHelmValues(agentConfig, relayerConfig);

  if (helmCommand === HelmCommand.InstallOrUpgrade) {
    // Delete secrets to avoid them being stale
    try {
      await execCmd(
        `kubectl delete secrets --namespace ${agentConfig.namespace} --selector app.kubernetes.io/instance=liquidity-layer-relayers`,
        {},
        false,
        false,
      );
    } catch (e) {
      console.error(e);
    }
  }

  return execCmd(
    `helm ${helmCommand} liquidity-layer-relayers ./helm/liquidity-layer-relayers --namespace ${
      relayerConfig.namespace
    } ${values.join(' ')}`,
    {},
    false,
    true,
  );
}

function getLiquidityLayerRelayerHelmValues(
  agentConfig: AgentContextConfig,
  relayerConfig: LiquidityLayerRelayerConfig,
) {
  const values = {
    hyperlane: {
      runEnv: agentConfig.runEnv,
      // Only used for fetching RPC urls as env vars
      chains: agentConfig.contextChainNames,
      connectionType: relayerConfig.connectionType,
    },
    image: {
      repository: relayerConfig.docker.repo,
      tag: relayerConfig.docker.tag,
    },
    infra: {
      prometheusPushGateway: relayerConfig.prometheusPushGateway,
    },
  };
  return helmifyValues(values);
}

export function getLiquidityLayerRelayerConfig(
  coreConfig: EnvironmentConfig,
): LiquidityLayerRelayerConfig {
  const relayerConfig = coreConfig.liquidityLayerConfig?.relayer;
  if (!relayerConfig) {
    throw new Error(
      `Environment ${coreConfig.environment} does not have a LiquidityLayerRelayerConfig config`,
    );
  }
  return relayerConfig;
}
