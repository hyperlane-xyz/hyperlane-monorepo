import { MultiProvider } from './provider';
import { AbacusAppContracts } from './contracts';
import { ChainName } from './types';

/**
 * Abstract class for interacting with collections of contracts on multiple
 * chains.
 */
export abstract class AbacusApp<T, V extends AbacusAppContracts<T>> extends MultiProvider {
  abstract contracts: Partial<Record<ChainName, V>>;
}
