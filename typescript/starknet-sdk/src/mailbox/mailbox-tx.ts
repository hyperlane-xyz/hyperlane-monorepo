import { type RpcProvider } from 'starknet';

import { ZERO_ADDRESS_HEX_32 } from '@hyperlane-xyz/utils';

import {
  StarknetContractName,
  getStarknetContract,
  normalizeStarknetAddressSafe,
  populateInvokeTx,
} from '../contracts.js';
import { type StarknetAnnotatedTx } from '../types.js';

export function getCreateMailboxTx(
  signer: string,
  config: {
    domainId: number;
    defaultIsmAddress?: string;
    defaultHookAddress?: string;
    requiredHookAddress?: string;
  },
): StarknetAnnotatedTx {
  return {
    kind: 'deploy',
    contractName: StarknetContractName.MAILBOX,
    constructorArgs: [
      config.domainId,
      normalizeStarknetAddressSafe(signer),
      normalizeStarknetAddressSafe(
        config.defaultIsmAddress ?? ZERO_ADDRESS_HEX_32,
      ),
      normalizeStarknetAddressSafe(
        config.defaultHookAddress ?? ZERO_ADDRESS_HEX_32,
      ),
      normalizeStarknetAddressSafe(
        config.requiredHookAddress ?? ZERO_ADDRESS_HEX_32,
      ),
    ],
  };
}

export async function getSetDefaultIsmTx(
  provider: RpcProvider,
  config: {
    mailboxAddress: string;
    ismAddress: string;
  },
): Promise<StarknetAnnotatedTx> {
  const mailbox = getStarknetContract(
    StarknetContractName.MAILBOX,
    config.mailboxAddress,
    provider,
  );
  return populateInvokeTx(mailbox, 'set_default_ism', [
    normalizeStarknetAddressSafe(config.ismAddress),
  ]);
}

export async function getSetDefaultHookTx(
  provider: RpcProvider,
  config: {
    mailboxAddress: string;
    hookAddress: string;
  },
): Promise<StarknetAnnotatedTx> {
  const mailbox = getStarknetContract(
    StarknetContractName.MAILBOX,
    config.mailboxAddress,
    provider,
  );
  return populateInvokeTx(mailbox, 'set_default_hook', [
    normalizeStarknetAddressSafe(config.hookAddress),
  ]);
}

export async function getSetRequiredHookTx(
  provider: RpcProvider,
  config: {
    mailboxAddress: string;
    hookAddress: string;
  },
): Promise<StarknetAnnotatedTx> {
  const mailbox = getStarknetContract(
    StarknetContractName.MAILBOX,
    config.mailboxAddress,
    provider,
  );
  return populateInvokeTx(mailbox, 'set_required_hook', [
    normalizeStarknetAddressSafe(config.hookAddress),
  ]);
}

export async function getSetMailboxOwnerTx(
  provider: RpcProvider,
  config: {
    mailboxAddress: string;
    newOwner: string;
  },
): Promise<StarknetAnnotatedTx> {
  const mailbox = getStarknetContract(
    StarknetContractName.MAILBOX,
    config.mailboxAddress,
    provider,
  );
  return populateInvokeTx(mailbox, 'transfer_ownership', [
    normalizeStarknetAddressSafe(config.newOwner),
  ]);
}
