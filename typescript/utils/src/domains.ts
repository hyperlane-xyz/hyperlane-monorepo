import { utils } from 'ethers';

import { addressToBytes32 } from './addresses.js';

export function domainHash(domain: number, merkle_tree_hook: string): string {
  return utils.solidityKeccak256(
    ['uint32', 'bytes32', 'string'],
    [domain, addressToBytes32(merkle_tree_hook), 'HYPERLANE'],
  );
}
