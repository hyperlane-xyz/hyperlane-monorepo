import { ChainMap, defaultMultisigConfigs } from '@hyperlane-xyz/sdk';
import { eqAddress } from '@hyperlane-xyz/utils';

import { isEthereumProtocolChain } from '../../src/utils/utils.js';
import { getArgs, withChains } from '../agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../core-utils.js';

const minimumValidatorCount = 3;

const getMinimumThreshold = (validatorCount: number): number =>
  Math.floor(validatorCount / 2) + 1;

const thresholdOK = 'threshold OK';
const totalOK = 'total OK';

enum CheckResult {
  OK = '✅',
  WARNING = '🚨',
}

async function main() {
  const { environment, chains } = await withChains(getArgs()).argv;
  const config = getEnvironmentConfig(environment);
  const { core } = await getHyperlaneCore(environment);

  // Ensure we skip lumia, as we don't have the addresses in registry.
  const targetNetworks = (
    chains && chains.length > 0 ? chains : config.supportedChainNames
  ).filter((chain) => isEthereumProtocolChain(chain) && chain !== 'lumia');

  const chainsWithUnannouncedValidators: ChainMap<string[]> = {};

  const results = await Promise.all(
    targetNetworks.map(async (chain) => {
      try {
        const validatorAnnounce = core.getContracts(chain).validatorAnnounce;
        const announcedValidators =
          await validatorAnnounce.getAnnouncedValidators();

        const defaultValidatorConfigs =
          defaultMultisigConfigs[chain].validators || [];
        const validators = defaultValidatorConfigs.map((v) => v.address);
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
        const minimumThreshold = getMinimumThreshold(validatorCount);

        return {
          chain,
          threshold,
          [thresholdOK]:
            threshold < minimumThreshold || threshold > validatorCount
              ? CheckResult.WARNING
              : CheckResult.OK,
          total: validatorCount,
          [totalOK]:
            validatorCount < minimumValidatorCount
              ? CheckResult.WARNING
              : CheckResult.OK,
          unannounced:
            unannouncedValidatorCount > 0 ? unannouncedValidatorCount : '',
        };
      } catch (error) {
        console.error(`Error processing chain ${chain}:`, error);
        return {
          chain,
          threshold: 'ERROR',
          [thresholdOK]: CheckResult.WARNING,
          total: 0,
          [totalOK]: CheckResult.WARNING,
          unannounced: 'ERROR',
        };
      }
    }),
  );

  console.table(results);

  const invalidThresholdChains = results
    .filter((r) => r[thresholdOK] === CheckResult.WARNING)
    .map((r) => r.chain);

  const lowValidatorCountChains = results
    .filter((r) => r[totalOK] === CheckResult.WARNING)
    .map((r) => ({
      chain: r.chain,
      neededValidators: minimumValidatorCount - r.total,
    }));

  if (invalidThresholdChains.length > 0) {
    console.log('\n⚠️ Chains with invalid thresholds:');
    invalidThresholdChains.forEach((chain) => {
      const validatorCount = defaultMultisigConfigs[chain].validators.length;
      const minimumThreshold = getMinimumThreshold(validatorCount);
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
