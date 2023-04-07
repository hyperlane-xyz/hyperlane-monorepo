import { Contexts } from '../../config/contexts';
import {
  getLiquidityLayerRelayerConfig,
  runLiquidityLayerRelayerHelmCommand,
} from '../../src/middleware/liquidity-layer-relayer';
import { HelmCommand } from '../../src/utils/helm';
import {
  assertCorrectKubeContext,
  getContextAgentConfig,
  getEnvironment,
  getEnvironmentConfig,
} from '../utils';

async function main() {
  const env = await getEnvironment();
  const envConfig = getEnvironmentConfig(env);

  await assertCorrectKubeContext(envConfig);

  const liquidityLayerRelayerConfig = getLiquidityLayerRelayerConfig(envConfig);
  const agentConfig = await getContextAgentConfig(
    envConfig,
    Contexts.Hyperlane,
  );

  await runLiquidityLayerRelayerHelmCommand(
    HelmCommand.InstallOrUpgrade,
    agentConfig,
    liquidityLayerRelayerConfig,
  );
}

main()
  .then(() => console.log('Deploy successful!'))
  .catch(console.error);
