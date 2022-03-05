import { types } from '@abacus-network/utils';

export type XAppCoreAddresses = {
  upgradeBeaconController: types.Address;
  xAppConnectionManager: types.Address;
};

export type XAppCoreConfig = Record<string, XAppCoreAddresses>;
