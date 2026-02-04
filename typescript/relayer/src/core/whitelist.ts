import type { ChainMap } from '@hyperlane-xyz/sdk';
import { Address, ParsedMessage, bytes32ToAddress } from '@hyperlane-xyz/utils';

export type MessageWhitelist = ChainMap<Set<Address>>;

// message must have origin and destination chains in the whitelist
// if whitelist has non-empty address set for chain, message must have sender and recipient in the set
export function messageMatchesWhitelist(
  whitelist: MessageWhitelist,
  message: ParsedMessage,
): boolean {
  const originAddresses = whitelist[message.originChain ?? message.origin];
  if (!originAddresses) {
    return false;
  }

  const sender = bytes32ToAddress(message.sender);
  if (originAddresses.size !== 0 && !originAddresses.has(sender)) {
    return false;
  }

  const destinationAddresses =
    whitelist[message.destinationChain ?? message.destination];
  if (!destinationAddresses) {
    return false;
  }

  const recipient = bytes32ToAddress(message.recipient);
  if (destinationAddresses.size !== 0 && !destinationAddresses.has(recipient)) {
    return false;
  }

  return true;
}
