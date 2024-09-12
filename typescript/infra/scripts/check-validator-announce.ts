import { ChainMap, defaultMultisigConfigs } from '@hyperlane-xyz/sdk';
import { eqAddress } from '@hyperlane-xyz/utils';

import { isEthereumProtocolChain } from '../src/utils/utils.js';

import { getArgs, withChains } from './agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from './core-utils.js';

const minimumValidatorCount = 3;

async function main() {
  const { environment, chains } = await withChains(getArgs()).argv;
  const config = getEnvironmentConfig(environment);
  const { core } = await getHyperlaneCore(environment);

  const targetNetworks = (
    chains && chains.length > 0 ? chains : config.supportedChainNames
  ).filter(isEthereumProtocolChain);

  const chainsWithUnannouncedValidators: ChainMap<string[]> = {};

  const results = await Promise.all(
    targetNetworks.map(async (chain) => {
      const validatorAnnounce = core.getContracts(chain).validatorAnnounce;
      const announcedValidators =
        await validatorAnnounce.getAnnouncedValidators();

      const validators = defaultMultisigConfigs[chain].validators || [];
      const unannouncedValidators = validators.filter(
        (validator) =>
          !announcedValidators.some((x) => eqAddress(x, validator)),
      );

      if (unannouncedValidators.length > 0) {
        chainsWithUnannouncedValidators[chain] = unannouncedValidators;
      }

      const validatorCount = validators.length;
      const unannouncedValidatorCount = unannouncedValidators.length;
      const threshold = defaultMultisigConfigs[chain].threshold;

      return {
        chain,
        threshold,
        'threshold OK':
          threshold <= validatorCount / 2 || threshold > validatorCount
            ? '🚨'
            : '✅',
        total: validatorCount,
        'total OK': validatorCount < minimumValidatorCount ? '🚨' : '✅',
        unannounced:
          unannouncedValidatorCount > 0 ? unannouncedValidatorCount : '',
      };
    }),
  );

  console.table(results);

  const invalidThresholdChains = results
    .filter((r) => r['threshold OK'] === '🚨')
    .map((r) => r.chain);

  const lowValidatorCountChains = results
    .filter((r) => r['total OK'] === '🚨')
    .map((r) => ({
      chain: r.chain,
      neededValidators: minimumValidatorCount - r.total,
    }));

  if (invalidThresholdChains.length > 0) {
    console.log('\n⚠️ Chains with invalid thresholds:');
    invalidThresholdChains.forEach((chain) => {
      const validatorCount = defaultMultisigConfigs[chain].validators.length;
      const minimumThreshold = Math.floor(validatorCount / 2) + 1;
      console.log(
        ` - ${chain}:`,
        `threshold should be ${minimumThreshold} ≤ t ≤ ${validatorCount}`,
      );
    });
  } else {
    console.log('\n✅ Thresholds look good!');
  }

  if (lowValidatorCountChains.length > 0) {
    console.log('\n⚠️ Chains with low validator counts:');
    lowValidatorCountChains.forEach((c) => {
      console.log(
        ` - ${c.chain}: needs ${c.neededValidators} more validator${
          c.neededValidators === 1 ? '' : 's'
        }`,
      );
    });
  } else {
    console.log('\n✅ Validator counts look good!');
  }

  const unnanouncedChains = Object.keys(chainsWithUnannouncedValidators);
  if (unnanouncedChains.length > 0) {
    console.log('\n⚠️ Chains with unannounced validators:');
    unnanouncedChains.forEach((chain) => {
      console.log(` - ${chain}: ${chainsWithUnannouncedValidators[chain]}`);
    });
  } else {
    console.log('\n✅ All validators announced!');
  }
}

main().catch(console.error);
