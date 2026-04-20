import { type RpcProvider } from 'starknet';

import {
  StarknetContractName,
  callContract,
  getStarknetContract,
  normalizeStarknetAddressSafe,
  toBigInt,
  toNumber,
} from '../contracts.js';

export interface StarknetMailboxConfig {
  address: string;
  owner: string;
  localDomain: number;
  defaultIsm: string;
  defaultHook: string;
  requiredHook: string;
  nonce: number;
}

export async function getMailboxConfig(
  provider: RpcProvider,
  mailboxAddress: string,
): Promise<StarknetMailboxConfig> {
  const mailbox = getStarknetContract(
    StarknetContractName.MAILBOX,
    mailboxAddress,
    provider,
  );

  const [owner, localDomain, defaultIsm, defaultHook, requiredHook, nonce] =
    await Promise.all([
      callContract(mailbox, 'owner'),
      callContract(mailbox, 'get_local_domain'),
      callContract(mailbox, 'get_default_ism'),
      callContract(mailbox, 'get_default_hook'),
      callContract(mailbox, 'get_required_hook'),
      callContract(mailbox, 'nonce'),
    ]);

  return {
    address: normalizeStarknetAddressSafe(mailboxAddress),
    owner: normalizeStarknetAddressSafe(owner),
    localDomain: toNumber(localDomain),
    defaultIsm: normalizeStarknetAddressSafe(defaultIsm),
    defaultHook: normalizeStarknetAddressSafe(defaultHook),
    requiredHook: normalizeStarknetAddressSafe(requiredHook),
    nonce: toNumber(nonce),
  };
}

export async function isMessageDelivered(
  provider: RpcProvider,
  mailboxAddress: string,
  messageId: string,
): Promise<boolean> {
  const mailbox = getStarknetContract(
    StarknetContractName.MAILBOX,
    mailboxAddress,
    provider,
  );
  const delivered = await callContract(mailbox, 'delivered', [messageId]);
  if (typeof delivered === 'boolean') return delivered;
  return toBigInt(delivered) !== 0n;
}
