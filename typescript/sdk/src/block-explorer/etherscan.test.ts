import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';

import { retryAsync } from '@hyperlane-xyz/utils';

import { getContractDeploymentTransaction } from './etherscan.js';
import {
  CONTRACT_ADDRESS,
  CONTRACT_CREATOR,
  DEPLOYMENT_TX_HASH,
  EXPLORER_API_URL,
  explorerResponse,
  explorerResultResponse,
} from './testFixtures.js';

chai.use(chaiAsPromised);

const DEPLOYMENT_BLOCK_NUMBER = 5755676;
// Mirrors retryAsync's own default, which is what EvmEventLogsReader relies on.
const ATTEMPT_LIMIT = 5;

interface RetryCase {
  name: string;
  body: unknown;
  expectedAttempts: number;
  expectedErrorIncludes: string;
}

const retryCases: RetryCase[] = [
  {
    // The explorer has answered; re-asking cannot change the answer, so the
    // error carries isRecoverable = false and retryAsync must give up at once.
    name: 'stops after one attempt when the explorer has no deployment record',
    body: { status: '0', message: 'No records found', result: [] },
    expectedAttempts: 1,
    expectedErrorIncludes: `No deployment transaction found for contract ${CONTRACT_ADDRESS}`,
  },
  {
    name: 'exhausts the retry budget when the explorer request fails',
    body: { status: '0', message: 'NOTOK', result: 'Max rate limit reached' },
    expectedAttempts: ATTEMPT_LIMIT,
    expectedErrorIncludes:
      'Error while performing request to Etherscan like API at explorer.example: NOTOK Max rate limit reached',
  },
];

interface BlockNumberCase {
  name: string;
  result: Record<string, unknown>;
  expectedBlockNumber?: number;
}

const blockNumberCases: BlockNumberCase[] = [
  {
    name: 'parses the decimal string block number returned by Etherscan and Blockscout',
    result: {
      contractAddress: CONTRACT_ADDRESS,
      contractCreator: CONTRACT_CREATOR,
      txHash: DEPLOYMENT_TX_HASH,
      blockNumber: `${DEPLOYMENT_BLOCK_NUMBER}`,
    },
    expectedBlockNumber: DEPLOYMENT_BLOCK_NUMBER,
  },
  {
    name: 'parses the JSON number block number returned by explorers like 0g chainscan',
    result: {
      contractAddress: CONTRACT_ADDRESS,
      contractCreator: CONTRACT_CREATOR,
      txHash: DEPLOYMENT_TX_HASH,
      blockNumber: DEPLOYMENT_BLOCK_NUMBER,
    },
    expectedBlockNumber: DEPLOYMENT_BLOCK_NUMBER,
  },
  {
    name: 'leaves the block number unset when the explorer does not report one',
    result: {
      contractAddress: CONTRACT_ADDRESS,
      contractCreator: CONTRACT_CREATOR,
      txHash: DEPLOYMENT_TX_HASH,
    },
    expectedBlockNumber: undefined,
  },
];

describe('getContractDeploymentTransaction', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  for (const c of blockNumberCases) {
    it(c.name, async () => {
      sandbox
        .stub(globalThis, 'fetch')
        .callsFake(async () => explorerResultResponse(c.result));

      const deploymentTx = await getContractDeploymentTransaction(
        { apiUrl: EXPLORER_API_URL },
        { contractAddress: CONTRACT_ADDRESS },
      );

      expect(deploymentTx.blockNumber).to.equal(c.expectedBlockNumber);
      expect(deploymentTx.txHash).to.equal(DEPLOYMENT_TX_HASH);
      expect(deploymentTx.contractCreator).to.equal(CONTRACT_CREATOR);
    });
  }

  it('rejects a block number that is not a hex or decimal number', async () => {
    sandbox.stub(globalThis, 'fetch').callsFake(async () =>
      explorerResultResponse({
        contractAddress: CONTRACT_ADDRESS,
        contractCreator: CONTRACT_CREATOR,
        txHash: DEPLOYMENT_TX_HASH,
        blockNumber: 'pending',
      }),
    );

    await expect(
      getContractDeploymentTransaction(
        { apiUrl: EXPLORER_API_URL },
        { contractAddress: CONTRACT_ADDRESS },
      ),
    ).to.be.rejectedWith(
      'blockNumber string "pending" is not a valid hex or decimal number',
    );
  });

  for (const c of retryCases) {
    it(c.name, async () => {
      const fetchStub = sandbox
        .stub(globalThis, 'fetch')
        .callsFake(async () => explorerResponse(c.body));

      let attempts = 0;
      await expect(
        retryAsync(
          () => {
            attempts++;
            return getContractDeploymentTransaction(
              { apiUrl: EXPLORER_API_URL },
              { contractAddress: CONTRACT_ADDRESS },
            );
          },
          ATTEMPT_LIMIT,
          1,
        ),
      ).to.be.rejectedWith(c.expectedErrorIncludes);

      expect(attempts).to.equal(c.expectedAttempts);
      expect(fetchStub.callCount).to.equal(c.expectedAttempts);
    });
  }
});
