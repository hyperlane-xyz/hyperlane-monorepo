import { expect } from 'chai';
import { helpers } from 'hardhat';
import { ethers } from 'ethers';

import { Validator } from '@abacus-network/abacus-sol/test/lib/Core';
import { CallData, Address } from '@abacus-network/abacus-sol/test/lib/types';
import { Inbox, TestInbox, Outbox } from '@abacus-network/abacus-sol/typechain';
import { GovernanceRouter } from '../../../typechain';

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
    to: helpers.abacus.ethersAddressToBytes32(destinationContract.address),
    data: callDataEncoded,
  };
}

export const increaseTimestampBy = async (
  provider: ethers.providers.JsonRpcProvider,
  increaseTime: number,
) => {
  await provider.send('evm_increaseTime', [increaseTime]);
  await provider.send('evm_mine', []);
};
