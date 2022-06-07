import { expect } from 'chai';
import { BigNumber, ethers } from 'ethers';

import { TestOutbox } from '../../types';
import { DispatchEvent } from '../../types/contracts/Outbox';

export interface Checkpoint {
  root: string;
  index: BigNumber;
}

export interface MerkleProof {
  branch: string[];
  item: string;
  index: BigNumber;
}

export interface DispatchReturnValues {
  proof: MerkleProof;
  checkpoint: Checkpoint;
  message: string;
}

const _dispatchMessage = async (
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

export const dispatchMessage = async (
  outbox: TestOutbox,
  destination: number,
  recipient: string,
  messageStr: string,
): Promise<DispatchReturnValues> => {
  const { leafIndex, message } = await _dispatchMessage(
    outbox,
    destination,
    recipient,
    messageStr,
  );
  // const item = utils.messageHash(message, leafIndex.toNumber());
  const item = ethers.utils.solidityKeccak256(['bytes'], [message]);
  const root = await outbox.root();
  const branch = await outbox.proof();
  return {
    checkpoint: {
      root,
      index: leafIndex,
    },
    proof: {
      branch,
      item,
      index: leafIndex,
    },
    message,
  };
};
