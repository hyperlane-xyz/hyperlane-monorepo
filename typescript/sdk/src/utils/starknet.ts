import { utils } from 'ethers';
import {
  Account,
  CairoOption,
  CairoOptionVariant,
  Contract,
  ParsedEvent,
  ParsedEvents,
  ParsedStruct,
  Provider,
} from 'starknet';

import {
  ContractType,
  getCompiledContract,
} from '@hyperlane-xyz/starknet-core';

import { DispatchedMessage } from '../core/types.js';
import { StarknetIsmContractName } from '../ism/starknet-utils.js';
import { SupportedIsmTypesOnStarknetType } from '../ism/types.js';

export interface Message {
  version: number;
  nonce: number;
  origin: number;
  sender: bigint;
  destination: number;
  recipient: bigint;
  body: { size: bigint; data: bigint[] };
}

export interface ByteData {
  value: bigint;
  size: number;
}

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

export function getStarknetHypERC20CollateralContract(
  address: string,
  signer?: Account | Provider,
): Contract {
  const { abi } = getCompiledContract('HypErc20Collateral', ContractType.TOKEN);
  return new Contract(abi, address, signer);
}

export function getStarknetHypNativeContract(
  address: string,
  signer?: Account | Provider,
): Contract {
  const { abi } = getCompiledContract('HypNative', ContractType.TOKEN);
  return new Contract(abi, address, signer);
}

export function getStarknetEtherContract(
  address: string,
  signer?: Account | Provider,
): Contract {
  const { abi } = getCompiledContract('Ether', ContractType.TOKEN);
  return new Contract(abi, address, signer);
}

export function getStarknetIsmContract(
  starkIsmType: SupportedIsmTypesOnStarknetType,
  address: string,
  signer?: Account | Provider,
): Contract {
  const { abi } = getCompiledContract(
    StarknetIsmContractName[starkIsmType],
    ContractType.CONTRACT,
  );
  return new Contract(abi, address, signer);
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

const DISPATCH_EVENT = 'contracts::mailbox::mailbox::Dispatch';
const DISPATCH_ID_EVENT = 'contracts::mailbox::mailbox::DispatchId';

export function parseStarknetDispatchEvents(
  parsedEvents: ParsedEvents,
  chainNameResolver: (domain: number) => string | undefined,
): DispatchedMessage[] {
  return parsedEvents
    .filter((event: ParsedEvent) => DISPATCH_EVENT in event)
    .map((dispatchEvent: ParsedEvent) => {
      const message = dispatchEvent[DISPATCH_EVENT].message as ParsedStruct;
      const originChain = chainNameResolver(Number(message.origin));
      const destinationChain = chainNameResolver(Number(message.destination));

      return {
        parsed: {
          ...message,
          originChain,
          destinationChain,
        },
        id: parseStarknetDispatchIdEvents(parsedEvents)[0],
        message: message.raw,
      } as DispatchedMessage;
    });
}

export function parseStarknetDispatchIdEvents(
  parsedEvents: ParsedEvents,
): string[] {
  return parsedEvents
    .filter((event: ParsedEvent) => DISPATCH_ID_EVENT in event)
    .map((dispatchEvent: ParsedEvent) =>
      utils.hexlify(dispatchEvent[DISPATCH_ID_EVENT].id as bigint),
    );
}
