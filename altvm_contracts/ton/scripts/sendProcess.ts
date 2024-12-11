import { toNano, Address, beginCell } from '@ton/core';
import { Mailbox } from '../wrappers/Mailbox';
import { NetworkProvider } from '@ton/blueprint';
import { TMultisigMetadata, TMessage } from '../wrappers/utils/types';
import * as deployedContracts from '../deployedContracts.json';
import { ethers } from 'ethers';
import { messageId, toEthSignedMessageHash } from '../tests/utils/signing';

export async function run(provider: NetworkProvider) {
    const recipient = Address.parse(deployedContracts.recipientAddress).hash;
    const sampleWallet = new ethers.Wallet(process.env.ETH_WALLET_PUBKEY!);

    const sender = Buffer.from(sampleWallet.address.slice(2).padStart(64, '0'), 'hex');

    const message: TMessage = {
        version: Number(process.env.MAILBOX_VERSION!),
        nonce: 0,
        origin: 777001,
        sender,
        destinationDomain: 777002,
        recipient,
        body: beginCell().storeUint(1234, 32).endCell(),
    };

    const originMerkleHook = Buffer.alloc(32);
    const root = Buffer.alloc(32);
    const index = 0n;
    const id = messageId(message);

    const domainHash = ethers.keccak256(
        ethers.solidityPacked(['uint32', 'bytes32', 'string'], [message.origin, originMerkleHook, 'HYPERLANE']),
    );

    const digest = ethers.keccak256(
        ethers.solidityPacked(['bytes32', 'bytes32', 'uint32', 'bytes32'], [domainHash, root, index, id]),
    );

    const ethSignedMessage = toEthSignedMessageHash(BigInt(digest));

    const signature = sampleWallet.signingKey.sign(ethSignedMessage);

    const metadata: TMultisigMetadata = {
        originMerkleHook,
        root,
        index,
        signatures: [
            {
                r: BigInt(signature.r),
                s: BigInt(signature.s),
                v: BigInt(signature.v),
            },
        ],
    };

    console.log('mailbox:', deployedContracts.mailboxAddress);
    console.log('recipient:', recipient);

    const mailbox = provider.open(Mailbox.createFromAddress(Address.parse(deployedContracts.mailboxAddress)));

    await mailbox.sendProcess(provider.sender(), toNano('0.1'), {
        blockNumber: 0,
        metadata,
        message,
    });
}
