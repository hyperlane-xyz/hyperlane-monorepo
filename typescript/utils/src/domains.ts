import { encodePacked, keccak256 } from 'viem';

import { addressToBytes32 } from './addresses.js';

export function domainHash(domain: number, merkle_tree_hook: string): string {
  return keccak256(
    encodePacked(
      ['uint32', 'bytes32', 'string'],
      [domain, addressToBytes32(merkle_tree_hook) as `0x${string}`, 'HYPERLANE'],
    ),
  );
}
