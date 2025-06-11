import { expect } from 'chai';
import { ethers } from 'ethers';

import {
  Address,
  HexString,
  MerkleProof,
  Validator,
  addressToBytes32,
  ensure0x,
  formatLegacyMultisigIsmMetadata,
  formatMessage,
  messageId,
  parseMessage,
} from '@hyperlane-xyz/utils';

import {
  LegacyMultisigIsm,
  TestMailbox,
  TestMerkleTreeHook,
} from '../../core-utils/typechain';
import { DispatchEvent } from '../../core-utils/typechain/contracts/Mailbox';

export type MessageAndProof = {
  proof: MerkleProof;
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
  utf8 = true,
) => {
  const tx = await mailbox['dispatch(uint32,bytes32,bytes)'](
    destination,
    recipient,
    utf8 ? ethers.utils.toUtf8Bytes(messageStr) : messageStr,
  );
  const receipt = await tx.wait();
  const dispatch = receipt.events![0] as DispatchEvent;
  expect(dispatch.event).to.equal('Dispatch');
  return dispatch.args!;
};

export const dispatchMessageAndReturnProof = async (
  mailbox: TestMailbox,
  merkleHook: TestMerkleTreeHook,
  destination: number,
  recipient: string,
  messageStr: string,
  utf8 = true,
): Promise<MessageAndProof> => {
  const nonce = await mailbox.nonce();
  const { message } = await dispatchMessage(
    mailbox,
    destination,
    addressToBytes32(recipient),
    messageStr,
    utf8,
  );
  const mid = messageId(message);
  const proof = await merkleHook.proof();
  return {
    proof: {
      branch: proof,
      leaf: mid,
      index: nonce,
    },
    message,
  };
};

// Signs a checkpoint with the provided validators and returns
// the signatures ordered by validator index
export async function signCheckpoint(
  root: HexString,
  index: number,
  mailbox: Address,
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
  merkleHook: TestMerkleTreeHook,
  multisigIsm: LegacyMultisigIsm,
  destination: number,
  recipient: string,
  messageStr: string,
  orderedValidators: Validator[],
  threshold?: number,
  utf8 = true,
): Promise<MessageAndMetadata> {
  // Checkpoint indices are 0 indexed, so we pull the count before
  // we dispatch the message.
  const index = await mailbox.nonce();
  const proofAndMessage = await dispatchMessageAndReturnProof(
    mailbox,
    merkleHook,
    destination,
    recipient,
    messageStr,
    utf8,
  );
  const root = await merkleHook.root();
  const signatures = await signCheckpoint(
    root,
    index,
    mailbox.address,
    orderedValidators,
  );
  const origin = parseMessage(proofAndMessage.message).origin;
  const metadata = formatLegacyMultisigIsmMetadata({
    checkpointRoot: root,
    checkpointIndex: index,
    originMailbox: mailbox.address,
    proof: proofAndMessage.proof.branch,
    signatures,
    validators: await multisigIsm.validators(origin),
  });
  return { metadata, message: proofAndMessage.message };
}

export function getCommitment(
  threshold: number,
  validators: Address[],
): string {
  const packed = ethers.utils.solidityPack(
    ['uint8', 'address[]'],
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
  const body = ensure0x(
    Buffer.from(ethers.utils.toUtf8Bytes(messageStr)).toString('hex'),
  );
  const nonce = await mailbox.nonce();
  const localDomain = await mailbox.localDomain();
  const message = formatMessage(
    version ?? (await mailbox.VERSION()),
    nonce,
    localDomain,
    sender,
    destination,
    recipient,
    body,
  );
  const id = messageId(message);
  return {
    message,
    id,
    body,
  };
};
