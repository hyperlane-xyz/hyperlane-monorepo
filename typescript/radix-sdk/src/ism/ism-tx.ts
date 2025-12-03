import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import {
  TransactionManifest,
  ValueKind,
  address,
  array,
  tuple,
  u32,
  u64,
} from '@radixdlt/radix-engine-toolkit';

import { strip0x } from '@hyperlane-xyz/utils';

import {
  getComponentOwnershipInfo,
  getRadixComponentDetails,
} from '../utils/base-query.js';
import { RadixBase } from '../utils/base.js';
import { INSTRUCTIONS, RadixIsmTypes } from '../utils/types.js';
import { bytes } from '../utils/utils.js';

export function getCreateNoopIsmTransaction(
  base: Readonly<RadixBase>,
  hyperlanePackageDefAddress: string,
  fromAddress: string,
): Promise<TransactionManifest> {
  return base.createCallFunctionManifest(
    fromAddress,
    hyperlanePackageDefAddress,
    RadixIsmTypes.NOOP_ISM,
    INSTRUCTIONS.INSTANTIATE,
    [],
  );
}

export function getCreateMerkleRootMultisigIsmTransaction(
  base: Readonly<RadixBase>,
  hyperlanePackageDefAddress: string,
  {
    fromAddress,
    validators,
    threshold,
  }: {
    fromAddress: string;
    validators: string[];
    threshold: number;
  },
): Promise<TransactionManifest> {
  return base.createCallFunctionManifest(
    fromAddress,
    hyperlanePackageDefAddress,
    RadixIsmTypes.MERKLE_ROOT_MULTISIG,
    INSTRUCTIONS.INSTANTIATE,
    [
      array(ValueKind.Array, ...validators.map((v) => bytes(strip0x(v)))),
      u64(threshold),
    ],
  );
}

export function getCreateMessageIdMultisigIsmTransaction(
  base: Readonly<RadixBase>,
  hyperlanePackageDefAddress: string,
  {
    fromAddress,
    validators,
    threshold,
  }: {
    fromAddress: string;
    validators: string[];
    threshold: number;
  },
): Promise<TransactionManifest> {
  return base.createCallFunctionManifest(
    fromAddress,
    hyperlanePackageDefAddress,
    RadixIsmTypes.MESSAGE_ID_MULTISIG,
    INSTRUCTIONS.INSTANTIATE,
    [
      array(ValueKind.Array, ...validators.map((v) => bytes(strip0x(v)))),
      u64(threshold),
    ],
  );
}

export function getCreateRoutingIsmTransaction(
  base: Readonly<RadixBase>,
  hyperlanePackageDefAddress: string,
  {
    fromAddress,
    routes,
  }: {
    fromAddress: string;
    routes: { ismAddress: string; domainId: number }[];
  },
): Promise<TransactionManifest> {
  return base.createCallFunctionManifest(
    fromAddress,
    hyperlanePackageDefAddress,
    RadixIsmTypes.ROUTING_ISM,
    INSTRUCTIONS.INSTANTIATE,
    [
      array(
        ValueKind.Tuple,
        ...routes.map((r) => tuple(u32(r.domainId), address(r.ismAddress))),
      ),
    ],
  );
}

export async function getSetRoutingIsmOwnerTransaction(
  base: Readonly<RadixBase>,
  gateway: Readonly<GatewayApiClient>,
  {
    fromAddress,
    ismAddress,
    newOwner,
  }: {
    fromAddress: string;
    ismAddress: string;
    newOwner: string;
  },
): Promise<TransactionManifest> {
  const ismDetails = await getRadixComponentDetails(
    gateway,
    ismAddress,
    RadixIsmTypes.ROUTING_ISM,
  );

  const ownershipInfo = getComponentOwnershipInfo(ismAddress, ismDetails);
  const resource =
    ownershipInfo.rule.access_rule.proof_rule.requirement.resource;

  return base.transfer({
    from_address: fromAddress,
    to_address: newOwner,
    resource_address: resource,
    amount: '1',
  });
}

export async function getSetRoutingIsmDomainIsmTransaction(
  base: Readonly<RadixBase>,
  {
    fromAddress,
    ismAddress,
    domainIsm,
  }: {
    fromAddress: string;
    ismAddress: string;
    domainIsm: { domainId: number; ismAddress: string };
  },
) {
  return base.createCallMethodManifestWithOwner(
    fromAddress,
    ismAddress,
    'set_route',
    [u32(domainIsm.domainId), address(domainIsm.ismAddress)],
  );
}

export async function getRemoveRoutingIsmDomainIsmTransaction(
  base: Readonly<RadixBase>,
  {
    fromAddress,
    ismAddress,
    domainId,
  }: {
    fromAddress: string;
    ismAddress: string;
    domainId: number;
  },
) {
  return base.createCallMethodManifestWithOwner(
    fromAddress,
    ismAddress,
    'remove_route',
    [u32(domainId)],
  );
}
