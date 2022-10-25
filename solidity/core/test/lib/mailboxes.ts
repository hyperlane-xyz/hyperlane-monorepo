import { expect } from 'chai';
import { ethers } from 'ethers';

import { types, utils } from '@hyperlane-xyz/utils';

import { TestMailbox } from '../../types';
import { DispatchEvent } from '../../types/contracts/Mailbox';

export const dispatchMessage = async (
  outbox: TestMailbox,
  destination: number,
  recipient: string,
  messageStr: string,
) => {
  const tx = await outbox.dispatch(
    destination,
    recipient,
    ethers.utils.toUtf8Bytes(messageStr),
  );
  const receipt = await tx.wait();
  const dispatch = receipt.events![0] as DispatchEvent;
  expect(dispatch.event).to.equal('Dispatch');
  return dispatch.args!;
};

export type MessageAndProof = {
  proof: types.MerkleProof;
  message: string;
};

export const dispatchMessageAndReturnProof = async (
  outbox: TestMailbox,
  destination: number,
  recipient: string,
  messageStr: string,
): Promise<MessageAndProof> => {
  const nonce = await outbox.count();
  const { message, messageId } = await dispatchMessage(
    outbox,
    destination,
    utils.addressToBytes32(recipient),
    messageStr,
  );
  const proof = await outbox.proof();
  return {
    proof: {
      branch: proof,
      leaf: messageId,
      index: nonce.toNumber(),
    },
    message,
  };
};

export const messageValues = async (
  mailbox: TestMailbox,
  sender: string,
  destination: number,
  recipient: string,
  messageStr: string,
) => {
  const body = utils.ensure0x(
    Buffer.from(ethers.utils.toUtf8Bytes(messageStr)).toString('hex'),
  );
  const nonce = await mailbox.count();
  const version = await mailbox.version();
  const localDomain = await mailbox.localDomain();
  const message = utils.formatMessage(
    nonce,
    version,
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
