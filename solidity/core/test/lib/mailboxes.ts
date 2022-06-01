import { expect } from 'chai';
import { ethers } from 'ethers';

import { types } from '@abacus-network/utils';

import { TestOutbox } from '../../types';

export const dispatchMessage = async (
  outbox: TestOutbox,
  destination: number,
  recipient: string,
  messageStr: string,
) => {
  const tx = await outbox.dispatch(
    destination,
    recipient,
    ethers.utils.formatBytes32String(messageStr),
  );
  const receipt = await tx.wait();
  const dispatch = receipt.events![0];
  expect(dispatch.event).to.equal('Dispatch');
  return dispatch.args!;
};

export const dispatchMessageAndReturnProof = async (
  outbox: TestOutbox,
  destination: number,
  recipient: string,
  messageStr: string,
) => {
  const { messageHash, leafIndex, message } = await dispatchMessage(
    outbox,
    destination,
    recipient,
    messageStr,
  );
  const root = await outbox.root();
  const proof = await outbox.proof();
  return {
    root,
    proof,
    leaf: messageHash,
    index: leafIndex,
    message,
  };
};

export interface MerkleProof {
  root: string;
  proof: types.BytesArray;
  leaf: string;
  index: number;
  message: string;
}
