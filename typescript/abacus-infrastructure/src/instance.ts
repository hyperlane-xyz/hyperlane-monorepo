import { types } from '@abacus-network/utils';
import { Instance } from '@abacus-network/abacus-deploy';

export abstract class InfraInstance<T> extends Instance<any> {
  abstract transferOwnership(owner: types.Address): Promise<void>;
}
