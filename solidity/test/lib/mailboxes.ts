import { expect } from 'chai';
import { ethers } from 'ethers';

import { Validator, types, utils } from '@hyperlane-xyz/utils';

import { TestMailboxV2 } from '../../types';
import { DispatchEvent } from '../../types/contracts/MailboxV2';

export type MessageAndProof = {
  proof: types.MerkleProof;
  message: string;
};

export type MessageAndMetadata = {
  message: string;
  metadata: string;
};

export const dispatchMessage = async (
  mailbox: TestMailboxV2,
  destination: number,
  recipient: string,
  messageStr: string,
) => {
  const tx = await mailbox.dispatch(
    destination,
    recipient,
    ethers.utils.toUtf8Bytes(messageStr),
  );
  const receipt = await tx.wait();
  const dispatch = receipt.events![0] as DispatchEvent;
  expect(dispatch.event).to.equal('Dispatch');
  return dispatch.args!;
};

export const dispatchMessageAndReturnProof = async (
  mailbox: TestMailboxV2,
  destination: number,
  recipient: string,
  messageStr: string,
): Promise<MessageAndProof> => {
  const nonce = await mailbox.count();
  const { message, messageId } = await dispatchMessage(
    mailbox,
    destination,
    utils.addressToBytes32(recipient),
    messageStr,
  );
  const proof = await mailbox.proof();
  return {
    proof: {
      branch: proof,
      leaf: messageId,
      index: nonce.toNumber(),
    },
    message,
  };
};

export const inferMessageValues = async (
  mailbox: TestMailboxV2,
  sender: string,
  destination: number,
  recipient: string,
  messageStr: string,
) => {
  const body = utils.ensure0x(
    Buffer.from(ethers.utils.toUtf8Bytes(messageStr)).toString('hex'),
  );
  const nonce = await mailbox.count();
  const version = await mailbox.VERSION();
  const localDomain = await mailbox.localDomain();
  const message = utils.formatMessageV2(
    nonce,
    version,
    localDomain,
    sender,
    destination,
    recipient,
    body,
  );
  const id = utils.messageIdV2(message);
  return {
    message,
    id,
    body,
  };
};

// Signs a checkpoint with the provided validators and returns
// the signatures sorted by validator addresses in ascending order
export async function signCheckpoint(
  root: types.HexString,
  index: number,
  mailbox: types.Address,
  unsortedValidators: Validator[],
): Promise<string[]> {
  const validators = unsortedValidators.sort((a, b) => {
    // Remove the checksums for accurate comparison
    const aAddress = a.address.toLowerCase();
    return aAddress.localeCompare(b.address.toLowerCase());
  });

  const signedCheckpoints = await Promise.all(
    validators.map((validator) =>
      validator.signCheckpointV2(root, index, mailbox),
    ),
  );
  return signedCheckpoints.map(
    (signedCheckpoint) => signedCheckpoint.signature as string, // cast is safe because signCheckpoint serializes to hex
  );
}

export async function dispatchMessageAndReturnMetadata(
  mailbox: TestMailboxV2,
  destination: number,
  recipient: string,
  messageStr: string,
  validators: Validator[],
): Promise<MessageAndMetadata> {
  const proofAndMessage = await dispatchMessageAndReturnProof(
    mailbox,
    destination,
    recipient,
    messageStr,
  );
  const root = await mailbox.root();
  const index = await mailbox.count();
  const addresses = utils.sortAddresses(validators.map((v) => v.address));
  const signatures = await signCheckpoint(
    root,
    index.toNumber(),
    mailbox.address,
    validators,
  );
  const checkpoint = { root, index: index.toNumber(), signature: '' };
  const metadata = utils.formatMultisigModuleMetadata(
    checkpoint,
    mailbox.address,
    proofAndMessage.proof, // The merkle proof is unused
    signatures,
    addresses,
  );
  return { metadata, message: proofAndMessage.message };
}

export function getCommitment(
  threshold: number,
  validators: types.Address[],
): string {
  const sortedValidators = utils.sortAddresses(validators);
  const packed = ethers.utils.solidityPack(
    ['uint256', 'address[]'],
    [threshold, sortedValidators],
  );
  return ethers.utils.solidityKeccak256(['bytes'], [packed]);
}
