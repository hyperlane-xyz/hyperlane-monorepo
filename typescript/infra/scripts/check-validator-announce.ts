import { defaultMultisigConfigs } from '@hyperlane-xyz/sdk';
import { eqAddress } from '@hyperlane-xyz/utils';

import { isEthereumProtocolChain } from '../src/utils/utils.js';

import { getArgs, withChains } from './agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from './core-utils.js';

async function main() {
  const { environment, chains } = await withChains(getArgs()).argv;
  const config = getEnvironmentConfig(environment);
  const { core } = await getHyperlaneCore(environment);

  const targetNetworks = (
    chains && chains.length > 0 ? chains : config.supportedChainNames
  ).filter(isEthereumProtocolChain);

  const results = await Promise.all(
    targetNetworks.map(async (chain) => {
      const validatorAnnounce = core.getContracts(chain).validatorAnnounce;
      const announcedValidators =
        await validatorAnnounce.getAnnouncedValidators();

      const validators = defaultMultisigConfigs[chain].validators || [];
      const missingValidators = validators.filter(
        (validator) =>
          !announcedValidators.some((x) => eqAddress(x, validator)),
      );

      return {
        chain,
        status:
          missingValidators.length === 0 ? '✅' : missingValidators.join(', '),
      };
    }),
  );

  console.table(results);
}

main().catch(console.error);
