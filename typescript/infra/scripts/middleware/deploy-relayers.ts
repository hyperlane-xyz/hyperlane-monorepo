import { Contexts } from '../../config/contexts';
import {
  getLiquidityLayerRelayerConfig,
  runLiquidityLayerRelayerHelmCommand,
} from '../../src/middleware/liquidity-layer-relayer';
import { HelmCommand } from '../../src/utils/helm';
import {
  assertCorrectKubeContext,
  getContextAgentConfig,
  getEnvironmentConfig,
} from '../utils';

async function main() {
  const coreConfig = await getEnvironmentConfig();

  await assertCorrectKubeContext(coreConfig);

  const liquidityLayerRelayerConfig =
    getLiquidityLayerRelayerConfig(coreConfig);
  const agentConfig = await getContextAgentConfig(coreConfig, Contexts.Abacus);

  await runLiquidityLayerRelayerHelmCommand(
    HelmCommand.InstallOrUpgrade,
    agentConfig,
    liquidityLayerRelayerConfig,
  );
}

main()
  .then(() => console.log('Deploy successful!'))
  .catch(console.error);
