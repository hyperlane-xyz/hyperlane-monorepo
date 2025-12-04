import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import { address, u32 } from '@radixdlt/radix-engine-toolkit';

import {
  getComponentOwnershipInfo,
  getRadixComponentDetails,
} from '../utils/base-query.js';
import { RadixBase } from '../utils/base.js';
import { INSTRUCTIONS } from '../utils/types.js';

export async function getCreateMailboxTransaction(
  base: Readonly<RadixBase>,
  hyperlanePackageDefAddress: string,
  {
    fromAddress,
    domainId,
  }: {
    fromAddress: string;
    domainId: number;
  },
) {
  return base.createCallFunctionManifest(
    fromAddress,
    hyperlanePackageDefAddress,
    'Mailbox',
    INSTRUCTIONS.INSTANTIATE,
    [u32(domainId)],
  );
}

export async function getSetMailboxOwnerTransaction(
  base: Readonly<RadixBase>,
  gateway: Readonly<GatewayApiClient>,
  {
    fromAddress,
    mailboxAddress,
    newOwner,
  }: {
    fromAddress: string;
    mailboxAddress: string;
    newOwner: string;
  },
) {
  const mailboxDetails = await getRadixComponentDetails(
    gateway,
    mailboxAddress,
    'Mailbox',
  );

  const ownershipInfo = getComponentOwnershipInfo(
    mailboxAddress,
    mailboxDetails,
  );
  const resourceAddress =
    ownershipInfo.rule.access_rule.proof_rule.requirement.resource;

  return base.transfer({
    from_address: fromAddress,
    to_address: newOwner,
    resource_address: resourceAddress,
    amount: '1',
  });
}

export async function getSetMailboxRequiredHookTransaction(
  base: Readonly<RadixBase>,
  {
    fromAddress,
    mailboxAddress,
    hookAddress,
  }: {
    fromAddress: string;
    mailboxAddress: string;
    hookAddress: string;
  },
) {
  return base.createCallMethodManifestWithOwner(
    fromAddress,
    mailboxAddress,
    'set_required_hook',
    [address(hookAddress)],
  );
}

export async function getSetMailboxDefaultHookTransaction(
  base: Readonly<RadixBase>,
  {
    fromAddress,
    mailboxAddress,
    hookAddress,
  }: {
    fromAddress: string;
    mailboxAddress: string;
    hookAddress: string;
  },
) {
  return base.createCallMethodManifestWithOwner(
    fromAddress,
    mailboxAddress,
    'set_default_hook',
    [address(hookAddress)],
  );
}

export async function getSetMailboxDefaultIsmTransaction(
  base: Readonly<RadixBase>,
  {
    fromAddress,
    mailboxAddress,
    ismAddress,
  }: {
    fromAddress: string;
    mailboxAddress: string;
    ismAddress: string;
  },
) {
  return base.createCallMethodManifestWithOwner(
    fromAddress,
    mailboxAddress,
    'set_default_ism',
    [address(ismAddress)],
  );
}
