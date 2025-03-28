import { utils } from 'ethers';
import {
  AccountInterface,
  CairoOption,
  CairoOptionVariant,
  Contract,
  ParsedEvent,
  ParsedEvents,
  ParsedStruct,
  ProviderInterface,
} from 'starknet';

import {
  ContractType,
  getCompiledContract,
} from '@hyperlane-xyz/starknet-core';

import { DispatchedMessage } from '../core/types.js';
import { StarknetIsmContractName } from '../ism/starknet-utils.js';
import { SupportedIsmTypesOnStarknetType } from '../ism/types.js';

export enum StarknetContractName {
  MAILBOX = 'mailbox',
  HYP_ERC20 = 'HypErc20',
  HYP_ERC20_COLLATERAL = 'HypErc20Collateral',
  HYP_NATIVE = 'HypNative',
  ETHER = 'Ether',
  MERKLE_TREE_HOOK = 'merkle_tree_hook',
  NOOP_ISM = 'noop_ism',
  HOOK = 'hook',
  PROTOCOL_FEE = 'protocol_fee',
  VALIDATOR_ANNOUNCE = 'validator_announce',
  MESSAGE_RECIPIENT = 'message_recipient',
  DOMAIN_ROUTING_HOOK = 'domain_routing_hook',
  FALLBACK_DOMAIN_ROUTING_HOOK = 'fallback_domain_routing_hook',
  STATIC_AGGREGATION_HOOK = 'static_aggregation_hook',
}

export enum StarknetHookType {
  AGGREGATION = 'AGGREGATION',
  FALLBACK_ROUTING = 'FALLBACK_ROUTING',
  MAILBOX_DEFAULT_HOOK = 'MAILBOX_DEFAULT_HOOK',
  MERKLE_TREE = 'MERKLE_TREE',
  PROTOCOL_FEE = 'PROTOCOL_FEE',
  ROUTING = 'ROUTING',
  UNUSED = 'UNUSED',
}

export enum StarknetIsmType {
  AGGREGATION = 'AGGREGATION',
  CCIP_READ = 'CCIP_READ', // Not supported
  LEGACY_MULTISIG = 'LEGACY_MULTISIG', // Deprecated
  MERKLE_ROOT_MULTISIG = 'MERKLE_ROOT_MULTISIG',
  MESSAGE_ID_MULTISIG = 'MESSAGE_ID_MULTISIG',
  NULL = 'NULL',
  ROUTING = 'ROUTING',
  UNUSED = 'UNUSED',
}

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

/**
 * Creates a Starknet contract instance with the given parameters
 */
export function getStarknetContract(
  contractName: string,
  address: string,
  providerOrAccount?: ProviderInterface | AccountInterface,
  contractType: ContractType = ContractType.CONTRACT,
): Contract {
  const { abi } = getCompiledContract(contractName, contractType);
  return new Contract(abi, address, providerOrAccount);
}

export function getStarknetMailboxContract(
  address: string,
  providerOrAccount?: ProviderInterface | AccountInterface,
): Contract {
  return getStarknetContract(
    StarknetContractName.MAILBOX,
    address,
    providerOrAccount,
  );
}

export function getStarknetHypERC20Contract(
  address: string,
  providerOrAccount?: ProviderInterface | AccountInterface,
): Contract {
  return getStarknetContract(
    StarknetContractName.HYP_ERC20,
    address,
    providerOrAccount,
    ContractType.TOKEN,
  );
}

export function getStarknetHypERC20CollateralContract(
  address: string,
  providerOrAccount?: ProviderInterface | AccountInterface,
): Contract {
  return getStarknetContract(
    StarknetContractName.HYP_ERC20_COLLATERAL,
    address,
    providerOrAccount,
    ContractType.TOKEN,
  );
}

export function getStarknetHypNativeContract(
  address: string,
  providerOrAccount?: ProviderInterface | AccountInterface,
): Contract {
  return getStarknetContract(
    StarknetContractName.HYP_NATIVE,
    address,
    providerOrAccount,
    ContractType.TOKEN,
  );
}

export function getStarknetEtherContract(
  address: string,
  providerOrAccount?: ProviderInterface | AccountInterface,
): Contract {
  return getStarknetContract(
    StarknetContractName.ETHER,
    address,
    providerOrAccount,
    ContractType.TOKEN,
  );
}

export function getStarknetIsmContract(
  starkIsmType: SupportedIsmTypesOnStarknetType,
  address: string,
  providerOrAccount?: ProviderInterface | AccountInterface,
): Contract {
  return getStarknetContract(
    StarknetIsmContractName[starkIsmType],
    address,
    providerOrAccount,
  );
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
