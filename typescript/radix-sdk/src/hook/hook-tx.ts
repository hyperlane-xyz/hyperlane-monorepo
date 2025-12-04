import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import {
  TransactionManifest,
  ValueKind,
  address,
  array,
  tuple,
  u32,
  u128,
} from '@radixdlt/radix-engine-toolkit';

import {
  getComponentOwnershipInfo,
  getRadixComponentDetails,
} from '../utils/base-query.js';
import { RadixBase } from '../utils/base.js';
import { INSTRUCTIONS, RadixHookTypes } from '../utils/types.js';

export async function getCreateMerkleTreeHookTransaction(
  base: Readonly<RadixBase>,
  hyperlanePackageDefAddress: string,
  {
    fromAddress,
    mailboxAddress,
  }: {
    fromAddress: string;
    mailboxAddress: string;
  },
): Promise<TransactionManifest> {
  return base.createCallFunctionManifest(
    fromAddress,
    hyperlanePackageDefAddress,
    RadixHookTypes.MERKLE_TREE,
    INSTRUCTIONS.INSTANTIATE,
    [address(mailboxAddress)],
  );
}

export async function getCreateIgpTransaction(
  base: Readonly<RadixBase>,
  hyperlanePackageDefAddress: string,
  {
    fromAddress,
    nativeTokenDenom,
  }: {
    fromAddress: string;
    nativeTokenDenom: string;
  },
): Promise<TransactionManifest> {
  return base.createCallFunctionManifest(
    fromAddress,
    hyperlanePackageDefAddress,
    RadixHookTypes.IGP,
    INSTRUCTIONS.INSTANTIATE,
    [address(nativeTokenDenom)],
  );
}

export async function getSetIgpOwnerTransaction(
  base: Readonly<RadixBase>,
  gateway: Readonly<GatewayApiClient>,
  {
    fromAddress,
    igpAddress,
    newOwner,
  }: {
    fromAddress: string;
    igpAddress: string;
    newOwner: string;
  },
): Promise<TransactionManifest> {
  const hookDetails = await getRadixComponentDetails(
    gateway,
    igpAddress,
    RadixHookTypes.IGP,
  );

  const ownershipInfo = getComponentOwnershipInfo(igpAddress, hookDetails);
  const resourceAddress =
    ownershipInfo.rule.access_rule.proof_rule.requirement.resource;

  return base.transfer({
    from_address: fromAddress,
    to_address: newOwner,
    resource_address: resourceAddress,
    amount: '1',
  });
}

export async function getSetIgpDestinationGasConfigTransaction(
  base: Readonly<RadixBase>,
  {
    fromAddress,
    igpAddress,
    destinationGasConfig,
  }: {
    fromAddress: string;
    igpAddress: string;
    destinationGasConfig: {
      remoteDomainId: number;
      gasOracle: {
        tokenExchangeRate: string;
        gasPrice: string;
      };
      gasOverhead: string;
    };
  },
): Promise<TransactionManifest> {
  return base.createCallMethodManifestWithOwner(
    fromAddress,
    igpAddress,
    'set_destination_gas_configs',
    [
      array(
        ValueKind.Tuple,
        tuple(
          u32(destinationGasConfig.remoteDomainId),
          tuple(
            tuple(
              u128(destinationGasConfig.gasOracle.tokenExchangeRate),
              u128(destinationGasConfig.gasOracle.gasPrice),
            ),
            u128(destinationGasConfig.gasOverhead),
          ),
        ),
      ),
    ],
  );
}
