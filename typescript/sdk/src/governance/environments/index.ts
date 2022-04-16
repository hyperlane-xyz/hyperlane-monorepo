import { ChainSubsetMap, GovernanceContractAddresses } from '../../';
import { addresses as test } from './test';

export type GovernanceDeployedNetworks = keyof typeof test;

export const addresses: ChainSubsetMap<
  GovernanceDeployedNetworks,
  GovernanceContractAddresses
> = test;
