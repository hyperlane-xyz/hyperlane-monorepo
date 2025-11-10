import prompts from 'prompts';

import { ProtocolType } from '../../../utils/dist/types.js';
import { getChain } from '../../config/registry.js';
import { getAllCloudAgentKeys } from '../../src/agents/key-utils.js';
import { getArgs, withContext, withProtocol } from '../agent-utils.js';
import { getConfigsBasedOnArgs } from '../core-utils.js';

function getKeyArgs() {
  return withProtocol(withContext(getArgs()))
    .alias('p', 'protocol')
    .option('bech32Prefix', {
      type: 'string',
      description: 'The bech32 prefix for the Cosmos address',
    })
    .alias('b', 'bech32Prefix');
}

async function main() {
  const argv = await getKeyArgs().argv;
  const { agentConfig, envConfig } = await getConfigsBasedOnArgs(argv);

  if (argv.protocol === 'cosmos' || argv.protocol === 'cosmosnative') {
    if (!argv.bech32Prefix) {
      const bech32PrefixMap = envConfig.supportedChainNames.reduce<
        Record<string, string>
      >((acc, chainName) => {
        const chain = getChain(chainName);
        if (
          chain &&
          (chain.protocol === ProtocolType.Cosmos ||
            chain.protocol === ProtocolType.CosmosNative) &&
          chain.bech32Prefix
        ) {
          acc[chainName] = chain.bech32Prefix;
        }
        return acc;
      }, {});

      const response = await prompts({
        type: 'select',
        name: 'bech32Prefix',
        message: 'Select the bech32 prefix for Cosmos address:',
        choices: Object.entries(bech32PrefixMap).map(([chainName, prefix]) => ({
          title: chainName,
          value: prefix,
        })),
      });
      argv.bech32Prefix = response.bech32Prefix;
    }
  }

  const keys = getAllCloudAgentKeys(agentConfig);
  const keyInfoPromises = keys.map(async (key) => {
    let address = undefined;
    try {
      await key.fetch();
      address = key.addressForProtocol(argv.protocol, argv.bech32Prefix);
    } catch (e) {
      // Swallow error
      console.error('Error getting address', { key: key.identifier, e });
    }
    return {
      identifier: key.identifier,
      address,
    };
  });
  const keyInfos = (await Promise.all(keyInfoPromises)).filter(
    // remove any keys we could not get an address for
    ({ address }) => !!address,
  );
  console.log(JSON.stringify(keyInfos, null, 2));
}

main().catch(console.error);
