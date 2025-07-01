import { utils } from 'ethers';
import {
  AccountInterface,
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
import { Address, eqAddressStarknet } from '@hyperlane-xyz/utils';

import { DispatchedMessage } from '../core/types.js';
import { ChainMap, ChainName } from '../types.js';

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

export const STARKNET_FEE_TOKEN_ADDRESSES: ChainMap<Address> = {
  starknet:
    '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
  starknetsepolia:
    '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
  paradex: '0x7348407ebad690fec0cc8597e87dc16ef7b269a655ff72587dafff83d462be2',
  paradexsepolia:
    '0x06f373b346561036d98ea10fb3e60d2f459c872b1933b50b21fe6ef4fda3b75e',
};

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

export function isStarknetFeeToken(chainName: ChainName, address: string) {
  const feeTokenAddress = STARKNET_FEE_TOKEN_ADDRESSES[chainName];
  if (!feeTokenAddress) {
    return false;
  }

  return eqAddressStarknet(address, feeTokenAddress);
}

export function getStarknetFeeTokenContract(
  chainName: ChainName,
  providerOrAccount?: ProviderInterface | AccountInterface,
): Contract {
  const feeTokenAddress = STARKNET_FEE_TOKEN_ADDRESSES[chainName];
  if (!feeTokenAddress) {
    throw new Error(`No fee token address for chain ${chainName}`);
  }

  return getStarknetContract(
    StarknetContractName.ETHER,
    feeTokenAddress,
    providerOrAccount,
    ContractType.TOKEN,
  );
}
