import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import {
  TransactionManifest,
  address,
  u32,
} from '@radixdlt/radix-engine-toolkit';

import {
  getComponentOwnershipInfo,
  getRadixComponentDetails,
} from '../utils/base-query.js';
import { RadixBase } from '../utils/base.js';
import { INSTRUCTIONS } from '../utils/types.js';

export async function getCreateMailboxTx(
  base: Readonly<RadixBase>,
  fromAddress: string,
  domainId: number,
): Promise<TransactionManifest> {
  return base.createCallFunctionManifest(
    fromAddress,
    base.getHyperlanePackageDefAddress(),
    'Mailbox',
    INSTRUCTIONS.INSTANTIATE,
    [u32(domainId)],
  );
}

export async function getSetMailboxOwnerTx(
  base: Readonly<RadixBase>,
  gateway: Readonly<GatewayApiClient>,
  fromAddress: string,
  {
    mailboxAddress,
    newOwner,
  }: {
    mailboxAddress: string;
    newOwner: string;
  },
): Promise<TransactionManifest> {
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

export async function getSetMailboxRequiredHookTx(
  base: Readonly<RadixBase>,
  fromAddress: string,
  {
    mailboxAddress,
    hookAddress,
  }: {
    mailboxAddress: string;
    hookAddress: string;
  },
): Promise<TransactionManifest> {
  return base.createCallMethodManifestWithOwner(
    fromAddress,
    mailboxAddress,
    'set_required_hook',
    [address(hookAddress)],
  );
}

export async function getSetMailboxDefaultHookTx(
  base: Readonly<RadixBase>,
  fromAddress: string,
  {
    mailboxAddress,
    hookAddress,
  }: {
    mailboxAddress: string;
    hookAddress: string;
  },
): Promise<TransactionManifest> {
  return base.createCallMethodManifestWithOwner(
    fromAddress,
    mailboxAddress,
    'set_default_hook',
    [address(hookAddress)],
  );
}

export async function getSetMailboxDefaultIsmTx(
  base: Readonly<RadixBase>,
  fromAddress: string,
  {
    mailboxAddress,
    ismAddress,
  }: {
    mailboxAddress: string;
    ismAddress: string;
  },
): Promise<TransactionManifest> {
  return base.createCallMethodManifestWithOwner(
    fromAddress,
    mailboxAddress,
    'set_default_ism',
    [address(ismAddress)],
  );
}
