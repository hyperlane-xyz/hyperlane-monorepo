import {
  DomainRoutingIsmFactory__factory,
  StaticAggregationHookFactory__factory,
  StaticAggregationIsmFactory__factory,
  StaticMerkleRootMultisigIsmFactory__factory,
  StaticMerkleRootWeightedMultisigIsmFactory__factory,
  StaticMessageIdMultisigIsmFactory__factory,
  StaticMessageIdWeightedMultisigIsmFactory__factory,
} from '@hyperlane-xyz/core';
// TODO: Enforce that this list matches contracts that inherit from Create2-using
// base contracts (StaticAddressSetFactory, StaticThresholdAddressSetFactory,
// StaticWeightedValidatorSetFactory). These need the 0x41 prefix for Tron.
import {
  DomainRoutingIsmFactory__factory as TronDomainRoutingIsmFactory__factory,
  StaticAggregationHookFactory__factory as TronStaticAggregationHookFactory__factory,
  StaticAggregationIsmFactory__factory as TronStaticAggregationIsmFactory__factory,
  StaticMerkleRootMultisigIsmFactory__factory as TronStaticMerkleRootMultisigIsmFactory__factory,
  StaticMerkleRootWeightedMultisigIsmFactory__factory as TronStaticMerkleRootWeightedMultisigIsmFactory__factory,
  StaticMessageIdMultisigIsmFactory__factory as TronStaticMessageIdMultisigIsmFactory__factory,
  StaticMessageIdWeightedMultisigIsmFactory__factory as TronStaticMessageIdWeightedMultisigIsmFactory__factory,
} from '@hyperlane-xyz/tron-sdk';

// Any name changes here should also be reflected in the example artifacts.
// E.g. typescript/cli/examples/contract-artifacts.yaml
export const proxyFactoryFactories = {
  staticMerkleRootMultisigIsmFactory:
    new StaticMerkleRootMultisigIsmFactory__factory(),
  staticMessageIdMultisigIsmFactory:
    new StaticMessageIdMultisigIsmFactory__factory(),
  staticAggregationIsmFactory: new StaticAggregationIsmFactory__factory(),
  staticAggregationHookFactory: new StaticAggregationHookFactory__factory(),
  domainRoutingIsmFactory: new DomainRoutingIsmFactory__factory(),
  staticMerkleRootWeightedMultisigIsmFactory:
    new StaticMerkleRootWeightedMultisigIsmFactory__factory(),
  staticMessageIdWeightedMultisigIsmFactory:
    new StaticMessageIdWeightedMultisigIsmFactory__factory(),
};

// Tron factories compiled with 0x41 Create2 prefix for TVM compatibility
export const tronProxyFactoryFactories = {
  staticMerkleRootMultisigIsmFactory:
    new TronStaticMerkleRootMultisigIsmFactory__factory(),
  staticMessageIdMultisigIsmFactory:
    new TronStaticMessageIdMultisigIsmFactory__factory(),
  staticAggregationIsmFactory: new TronStaticAggregationIsmFactory__factory(),
  staticAggregationHookFactory: new TronStaticAggregationHookFactory__factory(),
  domainRoutingIsmFactory: new TronDomainRoutingIsmFactory__factory(),
  staticMerkleRootWeightedMultisigIsmFactory:
    new TronStaticMerkleRootWeightedMultisigIsmFactory__factory(),
  staticMessageIdWeightedMultisigIsmFactory:
    new TronStaticMessageIdWeightedMultisigIsmFactory__factory(),
};

export type ProxyFactoryFactories = typeof proxyFactoryFactories;

type ProxyFactoryImplementations = Record<keyof ProxyFactoryFactories, string>;

// must match contract names for verification
export const proxyFactoryImplementations: ProxyFactoryImplementations = {
  staticMerkleRootMultisigIsmFactory: 'StaticMerkleRootMultisigIsm',
  staticMessageIdMultisigIsmFactory: 'StaticMessageIdMultisigIsm',
  staticAggregationIsmFactory: 'StaticAggregationIsm',
  staticAggregationHookFactory: 'StaticAggregationHook',
  domainRoutingIsmFactory: 'DomainRoutingIsm',
  staticMerkleRootWeightedMultisigIsmFactory:
    'StaticMerkleRootWeightedMultisigIsm',
  staticMessageIdWeightedMultisigIsmFactory:
    'StaticMessageIdWeightedMultisigIsm',
};
