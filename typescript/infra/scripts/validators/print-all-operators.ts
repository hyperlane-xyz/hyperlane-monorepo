import {
  defaultMultisigConfigs,
  getValidatorFromStorageLocation,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  LogFormat,
  LogLevel,
  configureRootLogger,
  eqAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { isEthereumProtocolChain } from '../../src/utils/utils.js';
import { getArgs } from '../agent-utils.js';
import { getHyperlaneCore } from '../core-utils.js';

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);
  const { environment } = await getArgs().argv;

  const { core } = await getHyperlaneCore(environment);
  const operatorMap: Record<
    string,
    {
      alias: string;
      chains: Set<string>;
    }
  > = {};
  const chainSummary: Record<
    string,
    { defaultCount: number; nonDefaultCount: number; nearLatestCount: number }
  > = {};

  const targetNetworks = core.chains().filter((chain) => {
    const isEthereum = isEthereumProtocolChain(chain);
    if (!isEthereum) {
      rootLogger.info(`Skipping non-Ethereum chain: ${chain}`);
    }
    return isEthereum;
  });

  const results = await Promise.allSettled(
    targetNetworks.map(async (chain) => {
      const validatorAnnounce = core.getContracts(chain).validatorAnnounce;
      const announcedValidators = (
        await validatorAnnounce.getAnnouncedValidators()
      ).map((v) => v.toLowerCase());
      const storageLocations =
        await validatorAnnounce.getAnnouncedStorageLocations(
          announcedValidators,
        );

      const defaultIsmValidators =
        defaultMultisigConfigs[chain].validators || [];
      let latestCheckpoint = 0;

      let defaultCount = 0;
      let nonDefaultCount = 0;
      let nearLatestCount = 0;

      for (let i = 0; i < announcedValidators.length; i++) {
        const validator = announcedValidators[i];
        const location = storageLocations[i][0];

        const findDefaultValidatorAlias = (address: Address): string => {
          const validator = defaultIsmValidators.find((v) =>
            eqAddress(v.address, address),
          );
          return validator?.alias || '';
        };

        const isDefaultIsmValidator = findDefaultValidatorAlias(validator);
        if (isDefaultIsmValidator) {
          defaultCount++;
        } else {
          nonDefaultCount++;
        }

        try {
          const validatorInstance = await getValidatorFromStorageLocation(
            location,
          );
          const validatorCheckpoint =
            await validatorInstance.getLatestCheckpointIndex();

          if (isDefaultIsmValidator) {
            latestCheckpoint = Math.max(latestCheckpoint, validatorCheckpoint);
          } else {
            if (Math.abs(latestCheckpoint - validatorCheckpoint) <= 10) {
              nearLatestCount++;
            }
          }

          if (!operatorMap[validator]) {
            operatorMap[validator] = {
              alias: findDefaultValidatorAlias(validator),
              chains: new Set(),
            };
          }
          operatorMap[validator].chains.add(chain);
        } catch (error) {
          rootLogger[isDefaultIsmValidator ? 'error' : 'debug'](
            `Error getting metadata for ${validator} on chain ${chain}: ${error}`,
          );
        }
      }

      chainSummary[chain] = {
        defaultCount,
        nonDefaultCount,
        nearLatestCount,
      };

      return chain;
    }),
  );

  // Log any chains that failed
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      const chain = targetNetworks[index];
      rootLogger.error(`Failed to process chain ${chain}: ${result.reason}`);
    }
  });

  // Helper function to format operator info
  const formatOperatorInfo = (
    operator: string,
    chains: Set<string>,
    index: number,
    alias?: string,
  ) => {
    const header = alias
      ? `${index + 1}. ${operator} [${alias}]`
      : `${index + 1}. ${operator}`;
    return `${header}: ${chains.size}\n${Array.from(chains).join(', ')}\n`;
  };

  // Sort operators by number of chains they operate on
  const sortByChainCount = ([, opA]: any, [, opB]: any) =>
    opB.chains.size - opA.chains.size;

  // Print operators with aliases
  rootLogger.info('OPERATORS WITH ALIAS:');
  // First combine operators with same alias
  const aliasCombinedMap = Object.entries(operatorMap)
    .filter(([, { alias }]) => alias)
    .reduce((acc, [operator, { alias, chains }]) => {
      if (!acc[alias!]) {
        acc[alias!] = {
          addresses: [operator],
          chains: new Set(chains),
        };
      } else {
        acc[alias!].addresses.push(operator);
        chains.forEach((chain) => acc[alias!].chains.add(chain));
      }
      return acc;
    }, {} as Record<string, { addresses: string[]; chains: Set<string> }>);

  // Sort and print combined results
  Object.entries(aliasCombinedMap)
    .sort(([, a], [, b]) => b.chains.size - a.chains.size)
    .forEach(([alias, { chains }], index) => {
      rootLogger.info(formatOperatorInfo(alias, chains, index));
    });

  // Print operators without aliases
  rootLogger.info('\nOPERATORS WITHOUT ALIAS:');
  Object.entries(operatorMap)
    .filter(([, { alias }]) => !alias)
    .sort(sortByChainCount)
    .forEach(([operator, { chains }], index) => {
      rootLogger.info(formatOperatorInfo(operator, chains, index));
    });

  rootLogger.info('\nCHAIN SUMMARY:');
  // eslint-disable-next-line no-console
  console.table(
    Object.entries(chainSummary)
      .sort(([chainA], [chainB]) => chainB.localeCompare(chainA))
      .map(([chain, { defaultCount, nonDefaultCount, nearLatestCount }]) => ({
        chain,
        'default ISM validators': defaultCount,
        'total non-default': nonDefaultCount,
        'active non-default': nearLatestCount,
      })),
  );

  process.exit(0);
}

main().catch(rootLogger.error);
