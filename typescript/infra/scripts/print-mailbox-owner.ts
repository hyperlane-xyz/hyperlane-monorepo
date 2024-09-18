import { ethers } from 'ethers';

import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  ChainMap,
  CoreFactories,
  HyperlaneContracts,
  HyperlaneCore,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  eqAddressEvm,
  objFilter,
  objMap,
  promiseObjAll,
} from '@hyperlane-xyz/utils';

import { Contexts } from '../config/contexts.js';
import { DeployEnvironment } from '../src/config/environment.js';
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

const DEPLOYERS: Record<DeployEnvironment, Address> = {
  mainnet3: '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba',
  testnet4: '0xfaD1C94469700833717Fa8a3017278BC1cA8031C',
  test: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
};

export enum Owner {
  ICA = 'ICA',
  SAFE = 'SAFE',
  DEPLOYER = 'DEPLOYER KEY',
  UNKNOWN = 'UNKNOWN',
}

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

  const deployer = DEPLOYERS[environment];

  const mailboxOwners = await promiseObjAll(
    objMap(
      evmContractsMap,
      async (chain: string, contracts: HyperlaneContracts<CoreFactories>) => {
        // get possible owners from config
        const ownerConfig = envConfig.owners[chain];
        const safeAddress =
          ownerConfig.ownerOverrides?._safeAddress ??
          ethers.constants.AddressZero;
        const icaAddress =
          ownerConfig.ownerOverrides?._icaAddress ??
          ethers.constants.AddressZero;

        // get actual onchain owner
        const ownerAddress = await contracts.mailbox.owner();

        // determine owner type
        let ownerType = Owner.UNKNOWN;
        if (eqAddressEvm(ownerAddress, deployer)) {
          ownerType = Owner.DEPLOYER;
        } else if (eqAddressEvm(ownerAddress, safeAddress)) {
          ownerType = Owner.SAFE;
        } else if (eqAddressEvm(ownerAddress, icaAddress)) {
          ownerType = Owner.ICA;
        }

        return {
          owner: ownerAddress,
          type: ownerType,
        };
      },
    ),
  );

  console.table(mailboxOwners);

  const totalChains = Object.keys(mailboxOwners).length;
  console.log(`\nTotal chains: ${totalChains}`);

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
    console.error(e);
    process.exit(1);
  });
