import { expect } from 'chai';
import { ethers } from 'ethers';

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

export const dispatchMessageAndReturnProof = async (
  outbox: TestMailbox,
  destination: number,
  recipient: string,
  messageStr: string,
): Promise<MerkleProof> => {
  const { message } = await dispatchMessage(
    outbox,
    destination,
    recipient,
    messageStr,
  );
  const proof = await outbox.proof();
  return {
    proof: proof,
    message,
  };
};

export interface MerkleProof {
  proof: string[];
  message: string;
}
