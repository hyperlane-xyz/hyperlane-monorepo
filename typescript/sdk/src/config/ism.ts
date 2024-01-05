import { Address } from '@hyperlane-xyz/utils';

import {
  AggregationIsmConfig,
  IsmType,
  MultisigIsmConfig,
  RoutingIsmConfig,
} from '../ism/types';
import { ChainMap, ChainName } from '../types';

export const merkleRootMultisig = (
  validators: Address[],
  threshold = validators.length,
): MultisigIsmConfig => {
  return {
    type: IsmType.MERKLE_ROOT_MULTISIG,
    validators,
    threshold,
  };
};

export const messageIdMultisig = (
  validators: Address[],
  threshold = validators.length,
): MultisigIsmConfig => {
  return {
    type: IsmType.MESSAGE_ID_MULTISIG,
    validators,
    threshold,
  };
};

export const routingIsm = (
  local_chain: string,
  multisigIsm: ChainMap<MultisigIsmConfig>,
  owner: string,
): RoutingIsmConfig => {
  return {
    type: IsmType.ROUTING,
    owner,
    domains: Object.fromEntries(
      Object.entries(multisigIsm).filter(([chain]) => chain !== local_chain),
    ),
  };
};

export const aggregationIsm = (
  validators: Address[],
  multisigThreshold = validators.length,
  aggregationThreshold = 2,
): AggregationIsmConfig => {
  return {
    type: IsmType.AGGREGATION,
    modules: [
      merkleRootMultisig(validators, multisigThreshold),
      messageIdMultisig(validators, multisigThreshold),
    ],
    threshold: aggregationThreshold,
  };
};

export const routingOverAggregation = (
  local: ChainName,
  owners: ChainMap<Address>,
  validators: Address[],
  multisigThreshold = validators.length,
  aggregationThreshold = 2,
): RoutingIsmConfig => {
  return {
    type: IsmType.ROUTING,
    owner: owners[local],
    domains: Object.keys(owners)
      .filter((chain) => chain !== local)
      .reduce(
        (acc, chain) => ({
          ...acc,
          [chain]: aggregationIsm(
            validators,
            multisigThreshold,
            aggregationThreshold,
          ),
        }),
        {},
      ),
  };
};
