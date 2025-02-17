import {
  Account,
  CairoOption,
  CairoOptionVariant,
  Contract,
  ParsedEvent,
  ParsedEvents,
  Provider,
} from 'starknet';

import {
  ContractType,
  getCompiledContract,
} from '@hyperlane-xyz/starknet-core';

import { DispatchedMessage } from '../core/types.js';

export function getStarknetMailboxContract(
  address: string,
  signer: Account | Provider,
): Contract {
  const { abi } = getCompiledContract('mailbox');
  return new Contract(abi, address, signer);
}

export function getStarknetHypERC20Contract(
  address: string,
  signer?: Account | Provider,
): Contract {
  const { abi } = getCompiledContract('HypErc20', ContractType.TOKEN);
  return new Contract(abi, address, signer);
}

export function parseStarknetDispatchedMessages(
  parsedEvents: ParsedEvents,
  chainNameResolver: (domain: number) => string | undefined,
): DispatchedMessage[] {
  return parsedEvents
    .filter(
      (event: ParsedEvent) => 'contracts::mailbox::mailbox::Dispatch' in event,
    )
    .map((event: any) => {
      const dispatchEvent = event['contracts::mailbox::mailbox::Dispatch'];
      const message = dispatchEvent.message;

      const originChain = chainNameResolver(message.origin);
      const destinationChain = chainNameResolver(message.destination);

      return {
        parsed: {
          ...message,
          originChain,
          destinationChain,
        },
        id: event.index,
        message: message.raw,
      } as DispatchedMessage;
    });
}

export async function quoteStarknetDispatch({
  mailboxContract,
  destinationDomain,
  recipientAddress,
  messageBody,
  customHookMetadata,
  customHook,
}: {
  mailboxContract: Contract;
  destinationDomain: number;
  recipientAddress: string;
  messageBody: {
    size: number;
    data: bigint[];
  };
  customHookMetadata?: string;
  customHook?: string;
}): Promise<string> {
  const nonOption = new CairoOption(CairoOptionVariant.None);

  const quote = await mailboxContract.call('quote_dispatch', [
    destinationDomain,
    recipientAddress,
    messageBody,
    customHookMetadata || nonOption,
    customHook || nonOption,
  ]);

  return quote.toString();
}
