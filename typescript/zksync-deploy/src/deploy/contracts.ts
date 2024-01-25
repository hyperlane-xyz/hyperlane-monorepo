//////////// FIXME: consider remove below
//////////// FIXME: consider remove above
import {
  DomainRoutingIsmFactory__factory,
  StaticAggregationHookFactory__factory,
  StaticAggregationIsmFactory__factory,
  StaticMerkleRootMultisigIsmFactory__factory,
  StaticMessageIdMultisigIsmFactory__factory,
} from '../../types';

import { DeploymentList } from './types';

export const ism: DeploymentList = {
  merkleRootMultisigIsmFactory: 'StaticMerkleRootMultisigIsm',
  messageIdMultisigIsmFactory: 'StaticMessageIdMultisigIsm',
  aggregationIsmFactory: 'StaticAggregationIsm',
  aggregationHookFactory: 'StaticAggregationHook',
  routingIsmFactory: 'DomaingRoutingIsm',
};

export const core: DeploymentList = {
  proxyAdmin: 'ProxyAdmin',
  core: 'Core',
  mailbox: 'Mailbox',
  validatorAnnounce: 'ValidatorAnnounce',
  defaultIsm: 'DefaultIsm',
};

export const proxyFactoryFactories = {
  merkleRootMultisigIsmFactory:
    new StaticMerkleRootMultisigIsmFactory__factory(),
  messageIdMultisigIsmFactory: new StaticMessageIdMultisigIsmFactory__factory(),
  aggregationIsmFactory: new StaticAggregationIsmFactory__factory(),
  aggregationHookFactory: new StaticAggregationHookFactory__factory(),
  routingIsmFactory: new DomainRoutingIsmFactory__factory(),
};

export type ProxyFactoryFactories = typeof proxyFactoryFactories;

type ProxyFactoryImplementations = Record<keyof ProxyFactoryFactories, string>;

// must match contract names for verification
export const proxyFactoryImplementations: ProxyFactoryImplementations = {
  merkleRootMultisigIsmFactory: 'StaticMerkleRootMultisigIsm',
  messageIdMultisigIsmFactory: 'StaticMessageIdMultisigIsm',
  aggregationIsmFactory: 'StaticAggregationIsm',
  aggregationHookFactory: 'StaticAggregationHook',
  routingIsmFactory: 'DomaingRoutingIsm',
};
