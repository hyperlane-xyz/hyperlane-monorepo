import {
  DomainRoutingIsmFactory__factory,
  StaticAggregationIsmFactory__factory,
  StaticMultisigIsmFactory__factory,
} from '@hyperlane-xyz/core';

export const ismFactoryFactories = {
  multisigIsmFactory: new StaticMultisigIsmFactory__factory(),
  aggregationIsmFactory: new StaticAggregationIsmFactory__factory(),
  routingIsmFactory: new DomainRoutingIsmFactory__factory(),
};

export type IsmFactoryFactories = typeof ismFactoryFactories;
