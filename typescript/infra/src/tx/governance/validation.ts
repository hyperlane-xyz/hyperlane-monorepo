import chalk from 'chalk';

import {
  ChainMap,
  ChainName,
  DerivedIsmConfig,
  EvmIsmReader,
  normalizeConfig,
} from '@hyperlane-xyz/sdk';
import { deepEquals, rootLogger } from '@hyperlane-xyz/utils';

import type { GovernanceDecoderState } from './types.js';

const logger = rootLogger.child({
  module: 'governance-validation',
});

const ismDerivationsInProgress: ChainMap<boolean> = {};

async function deriveIsmConfig(
  state: GovernanceDecoderState,
  chain: ChainName,
  module: string,
): Promise<DerivedIsmConfig> {
  const reader = new EvmIsmReader(state.multiProvider, chain);

  const startTime = Date.now();
  logger.info(chalk.italic.gray(`Deriving ISM config for ${chain}...`));
  ismDerivationsInProgress[chain] = true;

  const derivedConfig = await reader.deriveIsmConfig(module);

  delete ismDerivationsInProgress[chain];
  logger.info(
    chalk.italic.blue(
      'Finished deriving ISM config',
      chain,
      'in',
      (Date.now() - startTime) / (1000 * 60),
      'mins',
    ),
  );
  const remainingInProgress = Object.keys(ismDerivationsInProgress);
  logger.info(
    chalk.italic.gray(
      'Remaining derivations in progress:',
      remainingInProgress.length,
      'chains',
      remainingInProgress,
    ),
  );

  return derivedConfig;
}

export async function validateDefaultIsmConfig(
  state: GovernanceDecoderState,
  chain: ChainName,
  module: string,
): Promise<{
  module: string;
  insight: string;
}> {
  const derivedConfig = await deriveIsmConfig(state, chain, module);
  const expectedIsmConfig = state.coreConfig[chain].defaultIsm;

  let insight = '✅ matches expected ISM config';
  const normalizedDerived = normalizeConfig(derivedConfig);
  const normalizedExpected = normalizeConfig(expectedIsmConfig);
  if (!deepEquals(normalizedDerived, normalizedExpected)) {
    state.diagnostics.addFatal({
      chain,
      module,
      derivedConfig,
      expectedIsmConfig,
      info: 'Incorrect default ISM being set',
    });
    insight = `❌ fatal mismatch of ISM config`;
    logger.error(chalk.bold.red(`Mismatch of ISM config for chain ${chain}!`));
  }

  return {
    module,
    insight,
  };
}
