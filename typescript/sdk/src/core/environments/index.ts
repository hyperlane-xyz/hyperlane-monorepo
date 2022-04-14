import { CoreContractAddresses } from '../';
import { addresses as test } from './test';

export type CoreDeployedNetworks = keyof typeof test;

export const addresses: {
  [Network in CoreDeployedNetworks]: CoreContractAddresses<
    CoreDeployedNetworks,
    Network
  >;
} = test;
