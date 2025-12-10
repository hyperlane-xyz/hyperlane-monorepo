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

export async function getCreateNoopIsmTx(
  base: Readonly<RadixBase>,
  fromAddress: string,
): Promise<TransactionManifest> {
  return base.createCallFunctionManifest(
    fromAddress,
    base.getHyperlanePackageDefAddress(),
    RadixIsmTypes.NOOP_ISM,
    INSTRUCTIONS.INSTANTIATE,
    [],
  );
}

type CreateMultisigIsmTxConfig = {
  validators: string[];
  threshold: number;
};

export async function getCreateMerkleRootMultisigIsmTx(
  base: Readonly<RadixBase>,
  fromAddress: string,
  { validators, threshold }: CreateMultisigIsmTxConfig,
): Promise<TransactionManifest> {
  return base.createCallFunctionManifest(
    fromAddress,
    base.getHyperlanePackageDefAddress(),
    RadixIsmTypes.MERKLE_ROOT_MULTISIG,
    INSTRUCTIONS.INSTANTIATE,
    [
      array(ValueKind.Array, ...validators.map((v) => bytes(strip0x(v)))),
      u64(threshold),
    ],
  );
}

export async function getCreateMessageIdMultisigIsmTx(
  base: Readonly<RadixBase>,
  fromAddress: string,
  { validators, threshold }: CreateMultisigIsmTxConfig,
): Promise<TransactionManifest> {
  return base.createCallFunctionManifest(
    fromAddress,
    base.getHyperlanePackageDefAddress(),
    RadixIsmTypes.MESSAGE_ID_MULTISIG,
    INSTRUCTIONS.INSTANTIATE,
    [
      array(ValueKind.Array, ...validators.map((v) => bytes(strip0x(v)))),
      u64(threshold),
    ],
  );
}

export async function getCreateRoutingIsmTx(
  base: Readonly<RadixBase>,
  fromAddress: string,
  routes: { ismAddress: string; domainId: number }[],
): Promise<TransactionManifest> {
  return base.createCallFunctionManifest(
    fromAddress,
    base.getHyperlanePackageDefAddress(),
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

export async function getSetRoutingIsmOwnerTx(
  base: Readonly<RadixBase>,
  gateway: Readonly<GatewayApiClient>,
  fromAddress: string,
  {
    ismAddress,
    newOwner,
  }: {
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

export async function getSetRoutingIsmDomainIsmTx(
  base: Readonly<RadixBase>,
  fromAddress: string,
  {
    ismAddress,
    domainIsm,
  }: {
    ismAddress: string;
    domainIsm: { domainId: number; ismAddress: string };
  },
): Promise<TransactionManifest> {
  return base.createCallMethodManifestWithOwner(
    fromAddress,
    ismAddress,
    'set_route',
    [u32(domainIsm.domainId), address(domainIsm.ismAddress)],
  );
}

export async function getRemoveRoutingIsmDomainIsmTx(
  base: Readonly<RadixBase>,
  fromAddress: string,
  {
    ismAddress,
    domainId,
  }: {
    ismAddress: string;
    domainId: number;
  },
): Promise<TransactionManifest> {
  return base.createCallMethodManifestWithOwner(
    fromAddress,
    ismAddress,
    'remove_route',
    [u32(domainId)],
  );
}
