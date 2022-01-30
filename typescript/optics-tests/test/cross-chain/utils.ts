import { expect } from 'chai';
import { ethers, optics } from 'hardhat';
import * as types from 'ethers';

import { Updater } from '../../lib/core';
import { Update, CallData, Address } from '../../lib/types';
import {
  Replica,
  TestReplica,
  Home,
  TestGovernanceRouter,
} from 'optics-ts-interface/dist/optics-core';

type MessageDetails = {
  message: string;
  destinationDomain: number;
  recipientAddress: Address;
};

/*
 * Dispatch a message from the specified Home contract
 * and return the updated root
 *
 * @param chainDetails - ChainDetails type containing every deployed domain
 * @param homeDomain - domain of the Home contract
 * @param messageDetails - Message type containing
 *   the message string,
 *   the destination domain to which the message will be sent,
 *   the recipient address on the destination domain to which the message will be dispatched
 *
 * @return newRoot - bytes32 of the latest root
 */
export async function dispatchMessage(
  home: Home,
  messageDetails: MessageDetails,
): Promise<string> {
  const { message, destinationDomain, recipientAddress } = messageDetails;

  // Send message with random signer address as msg.sender
  await home.dispatch(
    destinationDomain,
    optics.ethersAddressToBytes32(recipientAddress),
    ethers.utils.formatBytes32String(message),
  );

  return home.currentRoot();
}

/*
 * Dispatch a set of messages to the specified Home contract,
 * then sign and submit an update to the Home contract
 *
 * @param chainDetails - ChainDetails type containing every deployed domain
 * @param homeDomain - domain of the Home contract
 * @param messages - Message[]
 *
 * @return update - Update type
 */
export async function dispatchMessagesAndCommit(
  home: Home,
  messages: MessageDetails[],
  updater: Updater,
): Promise<Update> {
  // dispatch each message from Home
  for (let message of messages) {
    await dispatchMessage(home, message);
  }

  const root = await home.currentRoot();
  const index = await home.currentIndex();
  await expect(home.commit()).to.emit(home, 'Commit').withArgs(root, index);

  // ensure that Home committed root
  expect(await home.committedRoot()).to.equal(root);

  // sign the new commitment
  const { signature } = await updater.signUpdate(root, index);

  return {
    root,
    index,
    signature,
  };
}

/*
 * Submit a signed update to the Replica contract
 *
 * @param chainDetails - ChainDetails type containing every deployed domain
 * @param latestUpdateOnOriginChain - Update type, the last Update submitted to the Home chain for this Replica
 * @param homeDomain - domain of the Home contract from which the update originated
 * @param replicaDomain - domain of the Replica contract where the update will be submitted
 *
 * @return finalRoot - updated state root submitted to the Replica
 */
export async function updateReplica(
  update: Update,
  replica: Replica,
): Promise<string> {
  const homeDomain = await replica.remoteDomain();
  const { root, index, signature } = update;

  await expect(replica.update(root, index, signature))
    .to.emit(replica, 'Update')
    .withArgs(homeDomain, root, index, signature);

  expect(await replica.committedIndex()).to.equal(index);

  return root;
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

export async function formatOpticsMessage(
  replica: TestReplica,
  governorRouter: TestGovernanceRouter,
  destinationRouter: TestGovernanceRouter,
  message: string,
): Promise<string> {
  const nonce = 0;
  const governorDomain = await governorRouter.localDomain();
  const destinationDomain = await destinationRouter.localDomain();

  // Create Optics message that is sent from the governor domain and governor
  // to the nonGovernorRouter on the nonGovernorDomain
  const opticsMessage = optics.formatMessage(
    governorDomain,
    governorRouter.address,
    nonce,
    destinationDomain,
    destinationRouter.address,
    message,
  );

  // Set message status to MessageStatus.Pending
  await replica.setMessagePending(opticsMessage);

  return opticsMessage;
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
    to: optics.ethersAddressToBytes32(destinationContract.address),
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
