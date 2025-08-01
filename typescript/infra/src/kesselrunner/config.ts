import { ChainMap } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import {
  DISTRO_MAP,
  FALCON_MAP,
  FUNDER_MAP,
  NETWORK_MAP,
  ROUTE_MAP,
} from './consts.js';

// change this to testnet4 or mainnet3 to run on different networks
export const KESSEL_RUN_ENV: 'testnet4' | 'mainnet3' = 'testnet4';

export const MILLENNIUM_FALCON_ADDRESS: ChainMap<Address> =
  FALCON_MAP[KESSEL_RUN_ENV];
export const KESSEL_RUN_TARGET_NETWORKS = NETWORK_MAP[KESSEL_RUN_ENV];
export const KESSEL_RUN_FUNDER_CONFIG = {
  owner: '0xB282Db526832b160144Fc712fccEBC8ceFd9d19a',
  ...FUNDER_MAP[KESSEL_RUN_ENV],
} as const;

// rc-testnet4-key-kesselrunner-validator-0
export const KESSEL_RUN_OWNER_CONFIG = {
  owner: KESSEL_RUN_FUNDER_CONFIG.owner,
};

export const KESSEL_RUN_HOURLY_RATE = 250000;

export const KESSEL_RUN_CONFIG: {
  bursts: number;
  burstInterval: number;
  distArbOp: ChainMap<number>;
  distBaseBscEth: ChainMap<number>;
  distro: ChainMap<number>;
  multicallBatchSize: number;
} = {
  bursts: 10,
  burstInterval: 5, // seconds
  multicallBatchSize: 100,
  ...DISTRO_MAP[KESSEL_RUN_ENV],
};

export const KESSEL_RUN_SPICE_ROUTE: ChainMap<Address> =
  ROUTE_MAP[KESSEL_RUN_ENV];
