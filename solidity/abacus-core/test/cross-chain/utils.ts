import { expect } from 'chai';
import { ethers, abacus } from 'hardhat';
import * as types from 'ethers';

import { Validator } from '../lib/core';
import { CallData, Address } from '../lib/types';
import {
  Replica,
  TestReplica,
  Home,
  TestGovernanceRouter,
} from '../../typechain';

type MessageDetails = {
  message: string;
  destinationDomain: number;
  recipientAddress: Address;
};

/*
 * Dispatch a message from the specified Home contract.
 *
 * @param messageDetails - Message type containing
 *   the message string,
 *   the destination domain to which the message will be sent,
 *   the recipient address on the destination domain to which the message will be dispatched
 */
export async function dispatchMessage(
  home: Home,
  messageDetails: MessageDetails,
) {
  const { message, destinationDomain, recipientAddress } = messageDetails;

  // Send message with random signer address as msg.sender
  await home.dispatch(
    destinationDomain,
    abacus.ethersAddressToBytes32(recipientAddress),
    ethers.utils.formatBytes32String(message),
  );
}

/*
 * Dispatch a set of messages to the specified Home contract.
 *
 * @param messages - Message[]
 */
export async function dispatchMessages(home: Home, messages: MessageDetails[]) {
  for (let message of messages) {
    await dispatchMessage(home, message);
  }
}

/*
 * Checkpoints a Home, signs that checkpoint, and checkpoints the Replica
 *
 * @param home - The Home contract
 * @param replica - The Replica contract
 * @param validator - The Validator
 */
export async function checkpoint(
  home: Home,
  replica: Replica,
  validator: Validator,
) {
  await home.checkpoint();
  const [root, index] = await home.latestCheckpoint();
  const { signature } = await validator.signCheckpoint(root, index.toNumber());
  await replica.checkpoint(root, index, signature);
  const checkpointedIndex = await replica.checkpoints(root);
  expect(checkpointedIndex).to.equal(index);
}

/*
 * Format into a Message type
 *
 * @param messageString - string for the body of the message
 * @param messageDestinationDomain - domain where the message will be sent
 * @param messageRecipient - recipient of the message on the destination domain
 *
 * @return message - Message type
 */
export function formatMessage(
  message: string,
  destinationDomain: number,
  recipientAddress: Address,
): MessageDetails {
  return {
    message,
    destinationDomain,
    recipientAddress,
  };
}

export async function formatAbacusMessage(
  replica: TestReplica,
  governorRouter: TestGovernanceRouter,
  destinationRouter: TestGovernanceRouter,
  message: string,
): Promise<string> {
  const nonce = 0;
  const governorDomain = await governorRouter.localDomain();
  const destinationDomain = await destinationRouter.localDomain();

  // Create Abacus message that is sent from the governor domain and governor
  // to the nonGovernorRouter on the nonGovernorDomain
  const abacusMessage = abacus.formatMessage(
    governorDomain,
    governorRouter.address,
    nonce,
    destinationDomain,
    destinationRouter.address,
    message,
  );

  // Set message status to MessageStatus.Proven
  await replica.setMessageProven(abacusMessage);

  return abacusMessage;
}

export async function formatCall(
  destinationContract: types.Contract,
  functionStr: string,
  functionArgs: any[],
): Promise<CallData> {
  // Set up data for call message
  const callFunc = destinationContract.interface.getFunction(functionStr);
  const callDataEncoded = destinationContract.interface.encodeFunctionData(
    callFunc,
    functionArgs,
  );

  return {
    to: abacus.ethersAddressToBytes32(destinationContract.address),
    data: callDataEncoded,
  };
}

// Send a transaction from the specified signer
export async function sendFromSigner(
  signer: types.Signer,
  contract: types.Contract,
  functionName: string,
  args: any[],
) {
  const data = encodeData(contract, functionName, args);

  return signer.sendTransaction({
    to: contract.address,
    data,
  });
}

function encodeData(
  contract: types.Contract,
  functionName: string,
  args: any[],
): string {
  const func = contract.interface.getFunction(functionName);
  return contract.interface.encodeFunctionData(func, args);
}
