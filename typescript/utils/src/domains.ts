import { utils } from 'ethers';

import { addressToBytes32 } from './addresses';

export function domainHash(domain: number, mailbox: string): string {
  return utils.solidityKeccak256(
    ['uint32', 'bytes32', 'string'],
    [domain, addressToBytes32(mailbox), 'HYPERLANE'],
  );
}
