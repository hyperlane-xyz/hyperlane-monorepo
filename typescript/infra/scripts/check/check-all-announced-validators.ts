import { isEthereumProtocolChain } from '../../src/utils/utils.js';
import { getArgs, withChains } from '../agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../core-utils.js';

async function main() {
  const { environment } = await withChains(getArgs()).argv;
  const config = getEnvironmentConfig(environment);
  const { core } = await getHyperlaneCore(environment);

  const targetNetworks = config.supportedChainNames.filter(
    (chain) => isEthereumProtocolChain(chain) && chain !== 'lumia',
  );

  const results = await Promise.all(
    targetNetworks.map(async (chain) => {
      const validatorAnnounce = core.getContracts(chain).validatorAnnounce;
      let announcedValidators;
      try {
        announcedValidators = await validatorAnnounce.getAnnouncedValidators();
      } catch (e) {
        console.error(`Error getting announced validators for ${chain}:`, e);
        return {
          chain,
          announced: 0,
        };
      }

      return {
        chain,
        announced: announcedValidators.length,
      };
    }),
  );

  const totalAnnounced = results.reduce(
    (sum, result) => sum + result.announced,
    0,
  );

  console.table(results);
  console.log(
    `\nTotal validators announced across all chains: ${totalAnnounced}`,
  );
}

main().catch(console.error);
