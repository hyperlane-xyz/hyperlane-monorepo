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
