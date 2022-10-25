import { expect } from 'chai';
import { ethers } from 'ethers';

import { utils } from '@hyperlane-xyz/utils';

import { TestOutbox } from '../../types';
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
