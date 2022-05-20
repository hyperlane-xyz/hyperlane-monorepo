import { ethers } from 'ethers';

import { types, utils } from '@abacus-network/utils';

export enum ControllerMessage {
  CALL = 1,
  SETCONTROLLER = 2,
  ENROLLREMOTEROUTER = 3,
  SETXAPPCONNECTIONMANAGER = 5,
}

export function formatSetController(address: types.Address): string {
  return ethers.utils.solidityPack(
    ['bytes1', 'bytes32'],
    [ControllerMessage.SETCONTROLLER, utils.addressToBytes32(address)],
  );
}

export function formatSetAbacusConnectionManager(
  address: types.Address,
): string {
  return ethers.utils.solidityPack(
    ['bytes1', 'bytes32'],
    [
      ControllerMessage.SETXAPPCONNECTIONMANAGER,
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
      ControllerMessage.ENROLLREMOTEROUTER,
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
    [ControllerMessage.CALL, numCalls, callBody],
  );
}

export function formatCall<
  C extends ethers.Contract,
  I extends Parameters<C['interface']['encodeFunctionData']>,
>(
  destinationContract: C,
  functionName: I[0],
  functionArgs: I[1],
): types.CallData {
  // Set up data for call message
  const callData = utils.formatCallData(
    destinationContract,
    functionName as any,
    functionArgs as any,
  );
  return {
    to: utils.addressToBytes32(destinationContract.address),
    data: callData,
  };
}

export const increaseTimestampBy = async (
  provider: ethers.providers.JsonRpcProvider,
  increaseTime: number,
) => {
  await provider.send('evm_increaseTime', [increaseTime]);
  await provider.send('evm_mine', []);
};
