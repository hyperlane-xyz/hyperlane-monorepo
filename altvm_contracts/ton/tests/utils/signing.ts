import { Cell } from '@ton/core';
import { ethers, keccak256, solidityPacked, zeroPadValue } from 'ethers';
import { TMessage } from '../../wrappers/utils/types';
import { writeCellsToBuffer } from '../../wrappers/utils/convert';

export const signCell = (signer: ethers.Wallet, cell: Cell) => {
    const hash = cell.hash();
    const sig = signer.signingKey.sign(hash);

    return { v: BigInt(sig.v), r: BigInt(sig.r), s: BigInt(sig.s) };
};

export const toEthSignedMessageHash = (hash: bigint) => {
    return keccak256(
        solidityPacked(
            ['string', 'bytes32'],
            ['\\x19Ethereum Signed Message:\\n32', Buffer.from(hash.toString(16), 'hex')],
        ),
    );
};

export const messageId = (message: TMessage) => {
    return keccak256(
        solidityPacked(
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
