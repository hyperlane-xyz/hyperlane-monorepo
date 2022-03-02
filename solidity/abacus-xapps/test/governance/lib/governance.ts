import { ethers } from 'ethers';
import * as types from '@abacus-network/abacus-sol/test/lib/types';
import { getHexStringByteLength } from '@abacus-network/abacus-sol/test/lib/utils';
import { HardhatGovernanceHelpers } from '../../lib/types';

export enum GovernanceMessage {
  CALL = 1,
  SETGOVERNOR = 2,
  ENROLLREMOTEROUTER = 3,
  SETXAPPCONNECTIONMANAGER = 5,
}

function ethersAddressToBytes32(address: types.Address): string {
  return ethers.utils
    .hexZeroPad(ethers.utils.hexStripZeros(address), 32)
    .toLowerCase();
}

function formatSetGovernor(address: types.Address): string {
  return ethers.utils.solidityPack(
    ['bytes1', 'bytes32'],
    [GovernanceMessage.SETGOVERNOR, ethersAddressToBytes32(address)],
  );
}

function formatSetXAppConnectionManager(address: types.Address): string {
  return ethers.utils.solidityPack(
    ['bytes1', 'bytes32'],
    [
      GovernanceMessage.SETXAPPCONNECTIONMANAGER,
      ethersAddressToBytes32(address),
    ],
  );
}

function formatEnrollRemoteRouter(
  domain: types.Domain,
  address: types.Address,
): string {
  return ethers.utils.solidityPack(
    ['bytes1', 'uint32', 'bytes32'],
    [
      GovernanceMessage.ENROLLREMOTEROUTER,
      domain,
      ethersAddressToBytes32(address),
    ],
  );
}

function formatCalls(callsData: types.CallData[]): string {
  let callBody = '0x';
  const numCalls = callsData.length;

  for (let i = 0; i < numCalls; i++) {
    const { to, data } = callsData[i];
    const dataLen = getHexStringByteLength(data);

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

export const governance: HardhatGovernanceHelpers = {
  formatSetGovernor,
  formatSetXAppConnectionManager,
  formatEnrollRemoteRouter,
  formatCalls,
};
