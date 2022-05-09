import { TransactionConfig } from '@abacus-network/deploy';
import { ChainMap } from '@abacus-network/sdk';

export const alfajores: TransactionConfig = {
  confirmations: 1,
  overrides: {},
};

export const fuji: TransactionConfig = {
  confirmations: 1,
  overrides: {},
};

export const mumbai: TransactionConfig = {
  confirmations: 3,
  overrides: {},
};

export const kovan: TransactionConfig = {
  confirmations: 3,
  overrides: {},
};

export const test1: TransactionConfig = {
  confirmations: 1,
  overrides: {},
};

export const test2: TransactionConfig = {
  confirmations: 1,
  overrides: {},
};

export const test3: TransactionConfig = {
  confirmations: 1,
  overrides: {},
};

const _configs = {
  alfajores,
  fuji,
  mumbai,
  kovan,
  test1,
  test2,
  test3,
};

export type TemplateNetworks = keyof typeof _configs;
export type TestNetworks = 'test1' | 'test2' | 'test3';
export const testConfigs: ChainMap<TestNetworks, TransactionConfig> = {
  test1,
  test2,
  test3,
};

export const configs: ChainMap<keyof typeof _configs, TransactionConfig> =
  _configs;
