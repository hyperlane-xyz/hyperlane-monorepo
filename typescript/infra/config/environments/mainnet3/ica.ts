import {
  AggregationIsmConfig,
  IsmConfig,
  IsmType,
  MultisigConfig,
  MultisigIsmConfig,
  defaultMultisigConfigs,
} from '@hyperlane-xyz/sdk';
import { eqAddress } from '@hyperlane-xyz/utils';

import awValidators from './aw-validators/hyperlane.json';

// -- ISM config generation --

const merkleRoot = (multisig: MultisigConfig): MultisigIsmConfig => ({
  type: IsmType.MERKLE_ROOT_MULTISIG,
  ...multisig,
});

const messageIdIsm = (multisig: MultisigConfig): MultisigIsmConfig => ({
  type: IsmType.MESSAGE_ID_MULTISIG,
  ...multisig,
});

const aggregationIsm = (multisig: MultisigConfig): AggregationIsmConfig => ({
  type: IsmType.AGGREGATION,
  modules: [messageIdIsm(multisig), merkleRoot(multisig)],
  threshold: 1,
});

export function getIcaIsm(
  originChain: string,
  deployer: string,
  routingIsmOwner: string,
): IsmConfig {
  const multisig = defaultMultisigConfigs[originChain];
  const awValidator =
    awValidators[originChain as keyof typeof awValidators].validators?.[0];
  // Ensure the AW validator was found and is in the multisig.
  if (
    !awValidator ||
    !multisig.validators.find((v) => eqAddress(v, awValidator))
  ) {
    throw new Error(
      `AW validator for ${originChain} (address: ${awValidator}) found in the validator set`,
    );
  }

  // A routing ISM so that the ISM is mutable without requiring a new ICA,
  // as the ICA address depends on the ISM address.
  return {
    type: IsmType.ROUTING,
    owner: routingIsmOwner,
    domains: {
      [originChain]: {
        type: IsmType.AGGREGATION,
        modules: [
          // This will always use the default ISM.
          // We burn ownership and have no domains in the routing table.
          {
            type: IsmType.FALLBACK_ROUTING,
            owner: '0x000000000000000000000000000000000000dEaD',
            domains: {},
          },
          {
            type: IsmType.AGGREGATION,
            modules: [
              aggregationIsm(multisig),
              messageIdIsm({
                validators: [awValidator, deployer],
                threshold: 1,
              }),
            ],
            threshold: 1,
          },
        ],
        threshold: 2,
      },
    },
  };
}
