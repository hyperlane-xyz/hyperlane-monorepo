import { expect } from 'chai';
import { BigNumber, providers } from 'ethers';
import sinon from 'sinon';

import {
  CONTRACT_ADDRESS,
  CONTRACT_CREATOR,
  DEPLOYMENT_TX_HASH,
  EXPLORER_API_URL,
  explorerResultResponse,
} from '../../block-explorer/testFixtures.js';
import { TestChainName } from '../../consts/testChains.js';
import { MultiProvider } from '../../providers/MultiProvider.js';

import { EvmEtherscanLikeEventLogsReader } from './EvmEventLogsReader.js';

const EXPLORER_BLOCK_NUMBER = 5755676;
const RECEIPT_BLOCK_NUMBER = 22216691;

function deploymentReceipt(): providers.TransactionReceipt {
  return {
    to: CONTRACT_ADDRESS,
    from: CONTRACT_CREATOR,
    contractAddress: CONTRACT_ADDRESS,
    transactionIndex: 0,
    gasUsed: BigNumber.from(0),
    logsBloom: '0x',
    blockHash: `0x${'cd'.repeat(32)}`,
    transactionHash: DEPLOYMENT_TX_HASH,
    logs: [],
    blockNumber: RECEIPT_BLOCK_NUMBER,
    confirmations: 1,
    cumulativeGasUsed: BigNumber.from(0),
    effectiveGasPrice: BigNumber.from(0),
    byzantium: true,
    type: 2,
    status: 1,
  };
}

interface ExplorerBlockNumberCase {
  name: string;
  explorerResult: Record<string, unknown>;
}

const explorerBlockNumberCases: ExplorerBlockNumberCase[] = [
  {
    name: 'when the explorer reports the block number as a decimal string',
    explorerResult: {
      contractAddress: CONTRACT_ADDRESS,
      contractCreator: CONTRACT_CREATOR,
      txHash: DEPLOYMENT_TX_HASH,
      blockNumber: `${EXPLORER_BLOCK_NUMBER}`,
    },
  },
  {
    name: 'when the explorer reports the block number as a JSON number',
    explorerResult: {
      contractAddress: CONTRACT_ADDRESS,
      contractCreator: CONTRACT_CREATOR,
      txHash: DEPLOYMENT_TX_HASH,
      blockNumber: EXPLORER_BLOCK_NUMBER,
    },
  },
];

describe('EvmEtherscanLikeEventLogsReader.getContractDeploymentBlockNumber', () => {
  let sandbox: sinon.SinonSandbox;
  let receiptStub: sinon.SinonStub;
  let reader: EvmEtherscanLikeEventLogsReader;

  beforeEach(() => {
    sandbox = sinon.createSandbox();

    const provider = new providers.JsonRpcProvider(
      'http://127.0.0.1:8545',
      31337,
    );
    const multiProvider = MultiProvider.createTestMultiProvider({ provider });
    receiptStub = sandbox
      .stub(provider, 'getTransactionReceipt')
      .resolves(deploymentReceipt());

    reader = new EvmEtherscanLikeEventLogsReader(
      TestChainName.test1,
      { apiUrl: EXPLORER_API_URL },
      multiProvider,
    );
  });

  afterEach(() => {
    sandbox.restore();
  });

  for (const c of explorerBlockNumberCases) {
    it(`returns it without fetching the deployment receipt ${c.name}`, async () => {
      sandbox
        .stub(globalThis, 'fetch')
        .callsFake(async () => explorerResultResponse(c.explorerResult));

      const blockNumber =
        await reader.getContractDeploymentBlockNumber(CONTRACT_ADDRESS);

      expect(blockNumber).to.equal(EXPLORER_BLOCK_NUMBER);
      expect(receiptStub.notCalled).to.be.true;
    });
  }

  it('falls back to the deployment receipt when the explorer omits the block number', async () => {
    sandbox.stub(globalThis, 'fetch').callsFake(async () =>
      explorerResultResponse({
        contractAddress: CONTRACT_ADDRESS,
        contractCreator: CONTRACT_CREATOR,
        txHash: DEPLOYMENT_TX_HASH,
      }),
    );

    const blockNumber =
      await reader.getContractDeploymentBlockNumber(CONTRACT_ADDRESS);

    expect(blockNumber).to.equal(RECEIPT_BLOCK_NUMBER);
    expect(receiptStub.calledOnceWithExactly(DEPLOYMENT_TX_HASH)).to.be.true;
  });
});
