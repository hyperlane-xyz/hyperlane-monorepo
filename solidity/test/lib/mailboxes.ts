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

// Signs a checkpoint with the provided validators and returns
// the signatures ordered by validator index
export async function signCheckpoint(
  root: types.HexString,
  index: number,
  mailbox: types.Address,
  orderedValidators: Validator[],
): Promise<string[]> {
  const signedCheckpoints = await Promise.all(
    orderedValidators.map((validator) =>
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
  orderedValidators: Validator[],
): Promise<MessageAndMetadata> {
  const proofAndMessage = await dispatchMessageAndReturnProof(
    mailbox,
    destination,
    recipient,
    messageStr,
  );
  const root = await mailbox.root();
  const index = await mailbox.count();
  const validatorAddresses = orderedValidators.map((v) => v.address);
  const signatures = await signCheckpoint(
    root,
    index.toNumber(),
    mailbox.address,
    orderedValidators,
  );
  const checkpoint = { root, index: index.toNumber(), signature: '' };
  const metadata = utils.formatMultisigModuleMetadata({
    checkpointRoot: checkpoint.root,
    checkpointIndex: checkpoint.index,
    originMailbox: mailbox.address,
    proof: proofAndMessage.proof.branch, // The merkle proof is unused
    signatures,
    validators: validatorAddresses,
  });
  return { metadata, message: proofAndMessage.message };
}

export function getCommitment(
  threshold: number,
  validators: types.Address[],
): string {
  const packed = ethers.utils.solidityPack(
    ['uint256', 'address[]'],
    [threshold, validators],
  );
  return ethers.utils.solidityKeccak256(['bytes'], [packed]);
}

export const inferMessageValues = async (
  mailbox: TestMailboxV2,
  sender: string,
  destination: number,
  recipient: string,
  messageStr: string,
  version?: number,
) => {
  const body = utils.ensure0x(
    Buffer.from(ethers.utils.toUtf8Bytes(messageStr)).toString('hex'),
  );
  const nonce = await mailbox.count();
  const localDomain = await mailbox.localDomain();
  const message = utils.formatMessageV2(
    version ?? (await mailbox.VERSION()),
    nonce,
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
