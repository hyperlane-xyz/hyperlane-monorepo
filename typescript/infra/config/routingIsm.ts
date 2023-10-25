import {
  AggregationIsmConfig,
  ChainMap,
  ChainName,
  IsmConfig,
  ModuleType,
  RoutingIsmConfig,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { DeployEnvironment } from '../src/config';

import { aggregationIsm } from './aggregationIsm';
import { Contexts } from './contexts';
import { supportedChainNames as mainnet2Chains } from './environments/mainnet2/chains';
import { owners as mainnet2Owners } from './environments/mainnet2/owners';
import { chainNames as testChains } from './environments/test/chains';
import { owners as testOwners } from './environments/test/owners';
import { supportedChainNames as testnet4Chains } from './environments/testnet4/chains';
import { owners as testnet4Owners } from './environments/testnet4/owners';

const chains = {
  mainnet2: mainnet2Chains,
  testnet4: testnet4Chains,
  test: testChains,
};

const owners = {
  testnet4: testnet4Owners,
  mainnet2: mainnet2Owners,
  test: testOwners,
};

export const mainnetHyperlaneDefaultIsmCache: ChainMap<Address> = {
  ethereum: '0x3Ef03aEf1392E5e0C16fd4D22C3c3b4f81C8AF0C',
  optimism: '0xA7a0f9CB7d3bc3520A82ECF009F8f3949a926237',
  arbitrum: '0xD629aB5353D6B11f52eD80EFb26a28e5E347B52F',
  avalanche: '0x143A34E3Eaf1E77a8c994EcADb5268d717183150',
  polygon: '0xE1403b9d64185f715414A4a7BEcec124Bd9198A7',
  bsc: '0x307c66E1E2E9f20b6ED3c4561398215CF9b633c4',
  celo: '0xAC0246a09f1FEaF4CEe32e43792eE12d6B277332',
  moonbeam: '0xB32d147334AF9C15A65716Ab254a2460307648D1',
  gnosis: '0xF6c174AcC399eD8407663387857f30f92B0db958',
  solana: '6pHP4EeX2Xek24Be7PPTWCqcpmNEPENW1m9RnZSFSmA1',
};

// Intended to be the "entrypoint" ISM.
// Routing ISM => Aggregation (1/2)
//                 |              |
//                 |              |
//                 v              v
//            Merkle Root    Message ID
export const routingIsm = (
  environment: DeployEnvironment,
  local: ChainName,
  context: Contexts,
): RoutingIsmConfig | string => {
  if (environment === 'mainnet2' && context === Contexts.Hyperlane) {
    return mainnetHyperlaneDefaultIsmCache[local];
  }

  const aggregationIsms: ChainMap<AggregationIsmConfig> = chains[
    environment
  ].reduce(
    (acc, chain) => ({
      ...acc,
      [chain]: aggregationIsm(chain, context),
    }),
    {},
  );

  return {
    type: ModuleType.ROUTING,
    domains: aggregationIsms,
    owner: owners[environment][local],
  };
};

const replacerEnum = (key: string, value: any) => {
  if (key === 'type') {
    switch (value) {
      case ModuleType.AGGREGATION:
        return 'AGGREGATION';
      case ModuleType.ROUTING:
        return 'ROUTING';
      case ModuleType.MERKLE_ROOT_MULTISIG:
        return 'MERKLE_ROOT_MULTISIG';
      case ModuleType.LEGACY_MULTISIG:
        return 'LEGACY_MULTISIG';
      case ModuleType.MESSAGE_ID_MULTISIG:
        return 'MESSAGE_ID_MULTISIG';
      default:
        return value;
    }
  }
  return value;
};

export const printIsmConfig = (ism: IsmConfig): string => {
  return JSON.stringify(ism, replacerEnum, 2);
};
