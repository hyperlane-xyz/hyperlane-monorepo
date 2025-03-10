import { NetworkProvider } from '@ton/blueprint';
import { Address, beginCell, toNano } from '@ton/core';
import { ethers } from 'ethers';

import * as deployedContracts from '../deployedContracts.json';
import { messageId, toEthSignedMessageHash } from '../tests/utils/signing';
import { Mailbox } from '../wrappers/Mailbox';
import { multisigMetadataToCell } from '../wrappers/utils/builders';
import { HypMessage, TMultisigMetadata } from '../wrappers/utils/types';

export async function run(provider: NetworkProvider) {
  const recipient = Address.parse(deployedContracts.recipientAddress).hash;
  const sampleWallet = new ethers.Wallet(process.env.PRIVATE_KEY!);

  const sender = Buffer.from(
    sampleWallet.address.slice(2).padStart(64, '0'),
    'hex',
  );

  const message = HypMessage.fromAny({
    version: Mailbox.version,
    nonce: 0,
    origin: 777001,
    sender,
    destination: 777002,
    recipient,
    body: beginCell().storeUint(1234, 32).endCell(),
  });

  const originMerkleHook = Buffer.alloc(32);
  const root = Buffer.alloc(32);
  const index = 0n;
  const id = messageId(message);

  const domainHash = ethers.utils.keccak256(
    ethers.utils.solidityPack(
      ['uint32', 'bytes32', 'string'],
      [message.origin, originMerkleHook, 'HYPERLANE'],
    ),
  );

  const digest = ethers.utils.keccak256(
    ethers.utils.solidityPack(
      ['bytes32', 'bytes32', 'uint32', 'bytes32'],
      [domainHash, root, index, id],
    ),
  );

  const ethSignedMessage = toEthSignedMessageHash(BigInt(digest));

  const signature = sampleWallet._signingKey().signDigest(ethSignedMessage);

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

  const mailbox = provider.open(
    Mailbox.createFromAddress(Address.parse(deployedContracts.mailboxAddress)),
  );

  await mailbox.sendProcess(provider.sender(), toNano('0.1'), {
    metadata: multisigMetadataToCell(metadata),
    message: message.toCell(),
  });
}
