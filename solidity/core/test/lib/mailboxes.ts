import { expect } from 'chai';
import { BigNumber, ethers } from 'ethers';

import { types, utils } from '@abacus-network/utils';

import { TestOutbox } from '../../types';
import { Dispatch2Event } from '../../types/contracts/Outbox';

export interface Checkpoint {
  root: string;
  index: BigNumber;
}

export interface MerkleProof {
  checkpoint: Checkpoint;
  proof: types.BytesArray;
  leaf: string;
  message: string;
}

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
  const dispatch = receipt.events![0] as Dispatch2Event;
  expect(dispatch.event).to.equal('Dispatch2');
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
  const leaf = utils.messageHash(message, leafIndex.toNumber());
  const root = await outbox.root();
  const proof = await outbox.proof();
  return {
    checkpoint: {
      root,
      index: leafIndex,
    },
    proof: proof as types.BytesArray,
    leaf,
    message,
  };
};
