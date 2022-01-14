import * as ethers from 'ethers';
import { assert } from 'console';
import fs from 'fs';

import * as proxyUtils from '../proxyUtils';
import { CoreDeploy } from './CoreDeploy';
import * as contracts from '@optics-xyz/ts-interface/dist/optics-core';
import { checkCoreDeploy } from './checks';
import { toBytes32 } from '../utils';

function log(isTest: boolean, str: string) {
  if (!isTest) {
    console.log(str);
  }
}

function warn(text: string, padded: boolean = false) {
  if (padded) {
    const padding = '*'.repeat(text.length + 8);
    console.log(
      `
      ${padding}
      *** ${text.toUpperCase()} ***
      ${padding}
      `,
    );
  } else {
    console.log(`**** ${text.toUpperCase()} ****`);
  }
}

type ContractCall = {
  domain: number;
  contract: types.Contract;
  functionStr: string;
  functionArgs: any[];
}

type GovernanceMessageCall = {
  to: Address;
  // DataHexString?
  data: string;
}

// TODO: Dedup with typescript/optics-tests/test/cross-chain/utils.ts
export async function toGovernanceMessageCall(call: ContractCall): Promise<GovernanceMessageCall> {
  // Set up data for call message
  const callFunc = call.contract.interface.getFunction(call.functionStr);
  const callDataEncoded = call.contract.interface.encodeFunctionData(
    callFunc,
    call.functionArgs,
  );

  return {
    to: contract.address,
    data: callDataEncoded,
  };
}

export async function populateGovernanceTransaction(deploys: CoreDeploy[], call: ContractCall, governorRouter: BeaconProxy<contracts.GovernanceRouter>): Promise<UnsignedTx> {
  const message = await toGovernanceMessageCall(call)
  // Check if the upgrade is happening on the governor chain.
  const deploy = deploys.filter((x: CoreDeploy) => x.chain.domain === call.domain)[0]
  if (deploy.governor) {
    return governorRouter.populateTransaction.callLocal([message]);
  } else {
    return governorRouter.populateTransaction.callRemote(call.domain, [message]);
  }
}

/**
 * Writes unsigned governance transactions to a file. 
 *
 * @param txs - The array of unsigned txs.
 */
export function writeGovernanceOutput(txs: UnsignedTx[]) {
  log(deploys[0].test, `Have ${txs.length} txs`);
  const filename = `governance_${Date.now()}.json`;
  fs.writeFileSync(
    filename,
    JSON.stringify(txs, null, 2),
  );
}
