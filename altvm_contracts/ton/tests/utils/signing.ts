import { Cell } from '@ton/core';
import { ethers, utils } from 'ethers';

import { writeCellsToBuffer } from '../../wrappers/utils/convert';
import { TMessage } from '../../wrappers/utils/types';

export const signCell = (signer: ethers.Wallet, cell: Cell) => {
  const hash = cell.hash();
  const sig = signer._signingKey().signDigest(hash);

  return { v: BigInt(sig.v), r: BigInt(sig.r), s: BigInt(sig.s) };
};

export const toEthSignedMessageHash = (hash: bigint) => {
  return utils.keccak256(
    utils.solidityPack(
      ['string', 'bytes32'],
      [
        '\x19Ethereum Signed Message:\n32',
        Buffer.from(hash.toString(16), 'hex'),
      ],
    ),
  );
};

export const messageId = (message: TMessage) => {
  return utils.keccak256(
    utils.solidityPack(
      ['uint8', 'uint32', 'uint32', 'bytes32', 'uint32', 'bytes32', 'bytes'],
      [
        message.version,
        message.nonce,
        message.origin,
        message.sender,
        message.destinationDomain,
        message.recipient,
        writeCellsToBuffer(message.body),
      ],
    ),
  );
};
