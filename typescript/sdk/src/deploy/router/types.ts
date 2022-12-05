import type { types } from '@hyperlane-xyz/utils';

import type { ConnectionClientConfig, Router } from '../../router';
import { CheckerViolation } from '../types';

export type OwnableConfig = {
  owner: types.Address;
};

export type RouterConfig = ConnectionClientConfig & OwnableConfig;

export enum RouterViolationType {
  EnrolledRouter = 'EnrolledRouter',
}

export interface EnrolledRouterViolation extends CheckerViolation {
  type: RouterViolationType.EnrolledRouter;
  contract: Router;
  actual: string;
  expected: string;
}
