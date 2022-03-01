export enum GovernanceMessage {
  CALL = 1,
  TRANSFERGOVERNOR = 2,
  SETROUTER = 3,
}

function formatTransferGovernor(
  newDomain: types.Domain,
  newAddress: types.Address,
): string {
  return ethers.utils.solidityPack(
    ['bytes1', 'uint32', 'bytes32'],
    [GovernanceMessage.TRANSFERGOVERNOR, newDomain, newAddress],
  );
}

function formatSetRouter(domain: types.Domain, address: types.Address): string {
  return ethers.utils.solidityPack(
    ['bytes1', 'uint32', 'bytes32'],
    [GovernanceMessage.SETROUTER, domain, address],
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

export const abacus: types.HardhatGovernanceHelpers = {
  governance: {
    formatTransferGovernor,
    formatSetRouter,
    formatCalls,
  },
};
