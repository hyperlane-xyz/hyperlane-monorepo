import { ethers } from 'ethers';
import { types, utils } from '@abacus-network/abacus-sol/test';

export enum GovernanceMessage {
  CALL = 1,
  SETGOVERNOR = 2,
  ENROLLREMOTEROUTER = 3,
  SETXAPPCONNECTIONMANAGER = 5,
}

export function formatSetGovernor(address: types.Address): string {
  return ethers.utils.solidityPack(
    ['bytes1', 'bytes32'],
    [GovernanceMessage.SETGOVERNOR, utils.addressToBytes32(address)],
  );
}

export function formatSetXAppConnectionManager(address: types.Address): string {
  return ethers.utils.solidityPack(
    ['bytes1', 'bytes32'],
    [
      GovernanceMessage.SETXAPPCONNECTIONMANAGER,
      utils.addressToBytes32(address),
    ],
  );
}

export function formatEnrollRemoteRouter(
  domain: types.Domain,
  address: types.Address,
): string {
  return ethers.utils.solidityPack(
    ['bytes1', 'uint32', 'bytes32'],
    [
      GovernanceMessage.ENROLLREMOTEROUTER,
      domain,
      utils.addressToBytes32(address),
    ],
  );
}

export function formatCalls(callsData: types.CallData[]): string {
  let callBody = '0x';
  const numCalls = callsData.length;

  for (let i = 0; i < numCalls; i++) {
    const { to, data } = callsData[i];
    const dataLen = utils.getHexStringByteLength(data);

    if (!to || !data) {
      throw new Error(`Missing data in Call ${i + 1}: \n  ${callsData[i]}`);
    }

    let hexBytes = ethers.utils.solidityPack(
      ['bytes32', 'uint256', 'bytes'],
      [to, dataLen, data],
    );

    // remove 0x before appending
    callBody += hexBytes.slice(2);
  }

  return ethers.utils.solidityPack(
    ['bytes1', 'bytes1', 'bytes'],
    [GovernanceMessage.CALL, numCalls, callBody],
  );
}

export async function formatCall(
  destinationContract: ethers.Contract,
  functionStr: string,
  functionArgs: any[],
): Promise<types.CallData> {
  // Set up data for call message
  const callFunc = destinationContract.interface.getFunction(functionStr);
  const callDataEncoded = destinationContract.interface.encodeFunctionData(
    callFunc,
    functionArgs,
  );

  return {
    to: utils.addressToBytes32(destinationContract.address),
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
