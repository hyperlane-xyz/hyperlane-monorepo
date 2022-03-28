import { types } from '@abacus-network/utils';
import { AbacusAppDeployer } from '../deploy';
import { Router } from './types';
export declare abstract class AbacusRouterDeployer<T, C> extends AbacusAppDeployer<T, C> {
    deploy(config: C): Promise<void>;
    get routerAddresses(): Record<types.Domain, types.Address>;
    abstract mustGetRouter(domain: types.Domain): Router;
}
//# sourceMappingURL=deploy.d.ts.map