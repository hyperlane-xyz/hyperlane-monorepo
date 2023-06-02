import { Contexts } from '../../config/contexts';
import {
  getLiquidityLayerRelayerConfig,
  runLiquidityLayerRelayerHelmCommand,
} from '../../src/middleware/liquidity-layer-relayer';
import { HelmCommand } from '../../src/utils/helm';
import { assertCorrectKubeContext, getConfigsBasedOnArgs } from '../utils';

async function main() {
  const { agentConfig, envConfig, context } = await getConfigsBasedOnArgs();
  if (context != Contexts.Hyperlane)
    throw new Error(`Context must be ${Contexts.Hyperlane}, but is ${context}`);

  await assertCorrectKubeContext(envConfig);

  const liquidityLayerRelayerConfig = getLiquidityLayerRelayerConfig(envConfig);

  await runLiquidityLayerRelayerHelmCommand(
    HelmCommand.InstallOrUpgrade,
    agentConfig,
    liquidityLayerRelayerConfig,
  );
}

main()
  .then(() => console.log('Deploy successful!'))
  .catch(console.error);
