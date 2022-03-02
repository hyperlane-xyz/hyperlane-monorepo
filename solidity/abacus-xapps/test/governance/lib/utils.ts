import { expect } from 'chai';
import { abacus } from 'hardhat';
import { ethers } from 'ethers';

import { Validator } from '@abacus-network/abacus-sol/test/lib/Core';
import { CallData, Address } from '@abacus-network/abacus-sol/test/lib/types';
import { Inbox, TestInbox, Outbox } from '@abacus-network/abacus-sol/typechain';
import { GovernanceRouter } from '../../../typechain';

type MessageDetails = {
  message: string;
  destinationDomain: number;
  recipientAddress: Address;
};

/*
 * Dispatch a message from the specified Outbox contract.
 *
 * @param messageDetails - Message type containing
 *   the message string,
 *   the destination domain to which the message will be sent,
 *   the recipient address on the destination domain to which the message will be dispatched
 */
export async function dispatchMessage(
  outbox: Outbox,
  messageDetails: MessageDetails,
) {
  const { message, destinationDomain, recipientAddress } = messageDetails;

  // Send message with random signer address as msg.sender
  await outbox.dispatch(
    destinationDomain,
    abacus.ethersAddressToBytes32(recipientAddress),
    ethers.utils.formatBytes32String(message),
  );
}

/*
 * Dispatch a set of messages to the specified Outbox contract.
 *
 * @param messages - Message[]
 */
export async function dispatchMessages(
  outbox: Outbox,
  messages: MessageDetails[],
) {
  for (let message of messages) {
    await dispatchMessage(outbox, message);
  }
}

/*
 * Checkpoints a Outbox, signs that checkpoint, and checkpoints the Inbox
 *
 * @param outbox - The Outbox contract
 * @param inbox - The Inbox contract
 * @param validator - The Validator
 */
export async function checkpoint(
  outbox: Outbox,
  inbox: Inbox,
  validator: Validator,
) {
  await outbox.checkpoint();
  const [root, index] = await outbox.latestCheckpoint();
  const { signature } = await validator.signCheckpoint(root, index.toNumber());
  await inbox.checkpoint(root, index, signature);
  const checkpointedIndex = await inbox.checkpoints(root);
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
  inbox: TestInbox,
  governorRouter: GovernanceRouter,
  destinationRouter: GovernanceRouter,
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
  await inbox.setMessageProven(abacusMessage);

  return abacusMessage;
}

export async function formatCall(
  destinationContract: ethers.Contract,
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
  signer: ethers.Signer,
  contract: ethers.Contract,
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
  contract: ethers.Contract,
  functionName: string,
  args: any[],
): string {
  const func = contract.interface.getFunction(functionName);
  return contract.interface.encodeFunctionData(func, args);
}

export const increaseTimestampBy = async (
  provider: ethers.providers.JsonRpcProvider,
  increaseTime: number,
) => {
  await provider.send('evm_increaseTime', [increaseTime]);
  await provider.send('evm_mine', []);
};
