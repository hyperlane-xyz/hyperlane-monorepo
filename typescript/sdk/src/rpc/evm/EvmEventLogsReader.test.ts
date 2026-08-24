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

import {
  EvmEtherscanLikeEventLogsReader,
  EvmEventLogsReader,
  EvmRpcEventLogsReader,
} from './EvmEventLogsReader.js';

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

describe('EvmEventLogsReader.getContractDeploymentBlock', () => {
  const RPC_BLOCK_NUMBER = 132196375;

  let sandbox: sinon.SinonSandbox;
  let multiProvider: MultiProvider;
  let explorerDeploymentBlock: sinon.SinonStub;
  let rpcDeploymentBlock: sinon.SinonStub;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    multiProvider = MultiProvider.createTestMultiProvider();

    explorerDeploymentBlock = sandbox
      .stub(
        EvmEtherscanLikeEventLogsReader.prototype,
        'getContractDeploymentBlockNumber',
      )
      .resolves(EXPLORER_BLOCK_NUMBER);
    rpcDeploymentBlock = sandbox
      .stub(EvmRpcEventLogsReader.prototype, 'getContractDeploymentBlockNumber')
      .resolves(RPC_BLOCK_NUMBER);
  });

  afterEach(() => {
    sandbox.restore();
  });

  function reader(): EvmEventLogsReader {
    return EvmEventLogsReader.fromConfig(
      { chain: TestChainName.test1 },
      multiProvider,
    );
  }

  it('resolves over the block explorer where the chain has one', async () => {
    expect(
      await reader().getContractDeploymentBlock(CONTRACT_ADDRESS),
    ).to.equal(EXPLORER_BLOCK_NUMBER);
    expect(rpcDeploymentBlock.called).to.be.false;
  });

  it('resolves it once per instance', async () => {
    const logsReader = reader();

    expect(
      await logsReader.getContractDeploymentBlock(CONTRACT_ADDRESS),
    ).to.equal(EXPLORER_BLOCK_NUMBER);
    expect(
      await logsReader.getContractDeploymentBlock(CONTRACT_ADDRESS),
    ).to.equal(EXPLORER_BLOCK_NUMBER);

    expect(explorerDeploymentBlock.calledOnce).to.be.true;
  });

  it('falls back to the RPC when the explorer cannot answer', async () => {
    explorerDeploymentBlock.rejects(new Error('NOTOK'));

    expect(
      await reader().getContractDeploymentBlock(CONTRACT_ADDRESS),
    ).to.equal(RPC_BLOCK_NUMBER);
  });

  it('raises when neither can answer', async () => {
    explorerDeploymentBlock.rejects(new Error('NOTOK'));
    rpcDeploymentBlock.rejects(new Error('missing trie node'));

    let thrown: unknown;
    try {
      await reader().getContractDeploymentBlock(CONTRACT_ADDRESS);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.be.instanceOf(Error);
    expect(thrown)
      .to.have.property('message')
      .that.includes('missing trie node');
  });
});
