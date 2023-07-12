import {
  DomainRoutingIsmFactory__factory,
  StaticAggregationIsmFactory__factory,
  StaticMerkleRootMultisigIsmFactory__factory,
  StaticMessageIdMultisigIsmFactory__factory,
} from '@hyperlane-xyz/core';

import { CCTPIsm__factory } from '../../../../solidity/dist';

export const ismFactoryFactories = {
  merkleRootMultisigIsmFactory:
    new StaticMerkleRootMultisigIsmFactory__factory(),
  messageIdMultisigIsmFactory: new StaticMessageIdMultisigIsmFactory__factory(),
  aggregationIsmFactory: new StaticAggregationIsmFactory__factory(),
  routingIsmFactory: new DomainRoutingIsmFactory__factory(),
};

export type IsmFactoryFactories = typeof ismFactoryFactories;

export const cctpIsmFactories = {
  cctpIsm: new CCTPIsm__factory(),
};

export type CctpIsmFactories = typeof cctpIsmFactories;
