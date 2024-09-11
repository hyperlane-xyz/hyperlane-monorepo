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
      const threshold = defaultMultisigConfigs[chain].threshold;

      return {
        chain,
        'unannounced validators':
          unannouncedValidators.length > 0 ? '🚨' : '✅',
        count: validatorCount,
        'threshold OK': threshold <= validatorCount / 2 ? '🚨' : '✅',
        'validator count OK':
          validatorCount < minimumValidatorCount ? '🚨' : '✅',
      };
    }),
  );

  console.table(results);

  const lowThresholdChains = results
    .filter((r) => r['threshold OK'] === '🚨')
    .map((r) => r.chain);

  const lowValidatorCountChains = results
    .filter((r) => r['validator count OK'] === '🚨')
    .map((r) => ({
      chain: r.chain,
      neededValidators: minimumValidatorCount - r.count,
    }));

  if (lowThresholdChains.length > 0) {
    console.log('Chains with low thresholds:');
    lowThresholdChains.forEach((chain) => {
      const validatorCount = defaultMultisigConfigs[chain].validators.length;
      const minimumThreshold = Math.floor(validatorCount / 2) + 1;
      console.log(
        ` - ${chain}: threshold should be at least ${minimumThreshold}`,
      );
    });
  }

  if (lowValidatorCountChains.length > 0) {
    console.log('\nChains with low validator counts:');
    lowValidatorCountChains.forEach((c) => {
      console.log(
        ` - ${c.chain}: needs ${c.neededValidators} more validator${
          c.neededValidators === 1 ? '' : 's'
        }`,
      );
    });
  }

  const unnanouncedChains = Object.keys(chainsWithUnannouncedValidators);
  if (unnanouncedChains.length > 0) {
    console.log('\nChains with unannounced validators:');
    unnanouncedChains.forEach((chain) => {
      console.log(` - ${chain}: ${chainsWithUnannouncedValidators[chain]}`);
    });
  }
}

main().catch(console.error);
