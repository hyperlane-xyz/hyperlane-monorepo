import {
  DomainRoutingIsmFactory__factory,
  StaticAggregationIsmFactory__factory,
  StaticMerkleRootMultisigIsmFactory__factory,
} from '@hyperlane-xyz/core';

export const ismFactoryFactories = {
  multisigIsmFactory: new StaticMerkleRootMultisigIsmFactory__factory(),
  aggregationIsmFactory: new StaticAggregationIsmFactory__factory(),
  routingIsmFactory: new DomainRoutingIsmFactory__factory(),
};

export type IsmFactoryFactories = typeof ismFactoryFactories;
