import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  ChainMap,
  CoreFactories,
  HyperlaneContracts,
  HyperlaneCore,
} from '@hyperlane-xyz/sdk';
import {
  objFilter,
  objMap,
  promiseObjAll,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { Contexts } from '../config/contexts.js';
import { Owner, determineGovernanceType } from '../src/governance.js';
import { Role } from '../src/roles.js';
import {
  filterRemoteDomainMetadata,
  isEthereumProtocolChain,
} from '../src/utils/utils.js';

import {
  Modules,
  getAddresses,
  getArgs,
  withAgentRoles,
  withChains,
  withContext,
} from './agent-utils.js';
import { getEnvironmentConfig } from './core-utils.js';

async function main() {
  const {
    context = Contexts.Hyperlane,
    environment,
    chains,
  } = await withContext(withChains(withAgentRoles(getArgs()))).argv;

  const envConfig = getEnvironmentConfig(environment);
  const chainsToCheck = (
    chains?.length ? chains : envConfig.supportedChainNames
  ).filter(isEthereumProtocolChain);

  const multiProvider = await envConfig.getMultiProvider(
    context,
    Role.Deployer,
    true,
    chainsToCheck,
  );

  // Get the addresses for the environment
  const addressesMap = getAddresses(
    environment,
    Modules.CORE,
  ) as ChainMap<ChainAddresses>;

  const addressesForEnv = filterRemoteDomainMetadata(addressesMap);
  const core = HyperlaneCore.fromAddressesMap(addressesForEnv, multiProvider);

  const evmContractsMap = objFilter(
    core.contractsMap,
    (chain, _): _ is HyperlaneContracts<CoreFactories> =>
      isEthereumProtocolChain(chain),
  );

  const mailboxOwners = await promiseObjAll(
    objMap(
      evmContractsMap,
      async (chain: string, contracts: HyperlaneContracts<CoreFactories>) => {
        // get actual onchain owner
        const ownerAddress = await contracts.mailbox.owner();
        const { ownerType, governanceType } = await determineGovernanceType(
          chain,
          ownerAddress,
        );
        return {
          owner: ownerAddress,
          type: ownerType,
          governance: governanceType,
        };
      },
    ),
  );

  // eslint-disable-next-line no-console
  console.table(mailboxOwners);

  const totalChains = Object.keys(mailboxOwners).length;
  rootLogger.info(`\nTotal chains: ${totalChains}`);

  // eslint-disable-next-line no-console
  console.table(
    Object.values(Owner).map((ownerType) => ({
      'Owner Type': ownerType,
      'Chain Count': Object.values(mailboxOwners).filter(
        ({ type }) => type === ownerType,
      ).length,
    })),
  );
}

main()
  .then()
  .catch((e) => {
    rootLogger.error(e);
    process.exit(1);
  });
