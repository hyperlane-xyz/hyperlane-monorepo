import { type RpcProvider } from 'starknet';

import { type AltVM } from '@hyperlane-xyz/provider-sdk';
import { ZERO_ADDRESS_HEX_32 } from '@hyperlane-xyz/utils';

import {
  StarknetContractName,
  getStarknetContract,
  normalizeStarknetAddressSafe,
  populateInvokeTx,
} from '../contracts.js';
import { type StarknetAnnotatedTx } from '../types.js';

export function getCreateMailboxTx(
  req: AltVM.ReqCreateMailbox,
): StarknetAnnotatedTx {
  return {
    kind: 'deploy',
    contractName: StarknetContractName.MAILBOX,
    constructorArgs: [
      req.domainId,
      normalizeStarknetAddressSafe(req.signer),
      normalizeStarknetAddressSafe(
        req.defaultIsmAddress ?? ZERO_ADDRESS_HEX_32,
      ),
      normalizeStarknetAddressSafe(
        req.defaultHookAddress ?? ZERO_ADDRESS_HEX_32,
      ),
      normalizeStarknetAddressSafe(
        req.requiredHookAddress ?? ZERO_ADDRESS_HEX_32,
      ),
    ],
  };
}

export async function getSetDefaultIsmTx(
  provider: RpcProvider,
  req: AltVM.ReqSetDefaultIsm,
): Promise<StarknetAnnotatedTx> {
  const mailbox = getStarknetContract(
    StarknetContractName.MAILBOX,
    req.mailboxAddress,
    provider,
  );
  return populateInvokeTx(mailbox, 'set_default_ism', [
    normalizeStarknetAddressSafe(req.ismAddress),
  ]);
}

export async function getSetDefaultHookTx(
  provider: RpcProvider,
  req: AltVM.ReqSetDefaultHook,
): Promise<StarknetAnnotatedTx> {
  const mailbox = getStarknetContract(
    StarknetContractName.MAILBOX,
    req.mailboxAddress,
    provider,
  );
  return populateInvokeTx(mailbox, 'set_default_hook', [
    normalizeStarknetAddressSafe(req.hookAddress),
  ]);
}

export async function getSetRequiredHookTx(
  provider: RpcProvider,
  req: AltVM.ReqSetRequiredHook,
): Promise<StarknetAnnotatedTx> {
  const mailbox = getStarknetContract(
    StarknetContractName.MAILBOX,
    req.mailboxAddress,
    provider,
  );
  return populateInvokeTx(mailbox, 'set_required_hook', [
    normalizeStarknetAddressSafe(req.hookAddress),
  ]);
}

export async function getSetMailboxOwnerTx(
  provider: RpcProvider,
  req: AltVM.ReqSetMailboxOwner,
): Promise<StarknetAnnotatedTx> {
  const mailbox = getStarknetContract(
    StarknetContractName.MAILBOX,
    req.mailboxAddress,
    provider,
  );
  return populateInvokeTx(mailbox, 'transfer_ownership', [
    normalizeStarknetAddressSafe(req.newOwner),
  ]);
}
