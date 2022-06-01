import { expect } from 'chai';
import { ethers } from 'ethers';

import { types } from '@abacus-network/utils';

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
    ethers.utils.formatBytes32String(messageStr),
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
