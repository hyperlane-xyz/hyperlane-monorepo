import { expect } from 'chai';
import { ethers } from 'ethers';

import { utils } from '@hyperlane-xyz/utils';

import { MailboxV2, TestOutbox } from '../../types';
import { DispatchEvent } from '../../types/contracts/Outbox';

export const dispatchMessage = async (
  outbox: TestOutbox,
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

export const dispatchMessageAndReturnProof = async (
  outbox: TestOutbox,
  destination: number,
  recipient: string,
  messageStr: string,
): Promise<MerkleProof> => {
  const { leafIndex, message } = await dispatchMessage(
    outbox,
    destination,
    recipient,
    messageStr,
  );
  const index = leafIndex.toNumber();
  const messageHash = utils.messageHash(message, index);
  const root = await outbox.root();
  const proof = await outbox.proof();
  return {
    root,
    proof: proof,
    leaf: messageHash,
    index,
    message,
  };
};

export interface MerkleProof {
  root: string;
  proof: string[];
  leaf: string;
  index: number;
  message: string;
}

export const inferMessageValues = async (
  mailbox: MailboxV2,
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
