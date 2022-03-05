import { types } from '@abacus-network/utils';
import { Router } from './types';
import { CommonInstance } from '../common';

export abstract class RouterInstance<T> extends CommonInstance<T> {
  abstract transferOwnership(owner: types.Address): Promise<void>;
  abstract router: Router;
}
