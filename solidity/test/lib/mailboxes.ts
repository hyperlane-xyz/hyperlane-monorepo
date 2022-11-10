import { expect } from 'chai';
import { ethers } from 'ethers';

import { Validator, types, utils } from '@hyperlane-xyz/utils';

import { MultisigIsm, TestMailbox } from '../../types';
import { DispatchEvent } from '../../types/contracts/MailboxV2.sol/Mailbox';

export type MessageAndProof = {
  proof: types.MerkleProof;
  message: string;
};

export type MessageAndMetadata = {
  message: string;
  metadata: string;
};

export const dispatchMessage = async (
  mailbox: TestMailbox,
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
  mailbox: TestMailbox,
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
    orderedValidators.map((validator) => validator.signCheckpoint(root, index)),
  );
  return signedCheckpoints.map(
    (signedCheckpoint) => signedCheckpoint.signature as string, // cast is safe because signCheckpoint serializes to hex
  );
}

export async function dispatchMessageAndReturnMetadata(
  mailbox: TestMailbox,
  multisigIsm: MultisigIsm,
  destination: number,
  recipient: string,
  messageStr: string,
  orderedValidators: Validator[],
): Promise<MessageAndMetadata> {
  // Checkpoint indices are 0 indexed, so we pull the count before
  // we dispatch the message.
  const index = await mailbox.count();
  const proofAndMessage = await dispatchMessageAndReturnProof(
    mailbox,
    destination,
    recipient,
    messageStr,
  );
  const root = await mailbox.root();
  const signatures = await signCheckpoint(
    root,
    index.toNumber(),
    mailbox.address,
    orderedValidators,
  );
  const origin = utils.parseMessage(proofAndMessage.message).origin;
  const metadata = utils.formatMultisigIsmMetadata({
    checkpointRoot: root,
    checkpointIndex: index.toNumber(),
    originMailbox: mailbox.address,
    proof: proofAndMessage.proof.branch,
    signatures,
    validators: await multisigIsm.validators(origin),
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
  mailbox: TestMailbox,
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
  const message = utils.formatMessage(
    version ?? (await mailbox.VERSION()),
    nonce,
    localDomain,
    sender,
    destination,
    recipient,
    body,
  );
  const id = utils.messageId(message);
  return {
    message,
    id,
    body,
  };
};
