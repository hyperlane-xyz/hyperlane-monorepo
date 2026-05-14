import { expect } from 'chai';
import { BigNumber, Wallet } from 'ethers';
import type { ContractReceipt } from 'ethers';
import { pino } from 'pino';
import sinon from 'sinon';
import { Writable } from 'stream';
import { z } from 'zod';

import { MultiProvider } from '@hyperlane-xyz/sdk';

import type { KeyFunderConfig } from '../config/types.js';
import { BridgeType } from '../config/types.js';

import { KeyFunder } from './KeyFunder.js';

const testLogger = pino({ level: 'silent' });
const LogRecordSchema = z
  .object({
    durationSeconds: z.number().optional(),
    error: z.unknown().optional(),
    msg: z.string().optional(),
  })
  .passthrough();

function createCapturingLogger() {
  const records: z.infer<typeof LogRecordSchema>[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of chunk.toString().trim().split('\n')) {
        if (!line) continue;
        const parsed = LogRecordSchema.safeParse(JSON.parse(line));
        if (parsed.success) records.push(parsed.data);
      }
      callback();
    },
  });
  return { logger: pino({ level: 'trace' }, stream), records };
}

describe('KeyFunder', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('should continue funding when recordFunderBalance fails', async () => {
    const { logger, records } = createCapturingLogger();

    const multiProvider = sinon.createStubInstance(MultiProvider);

    const config: KeyFunderConfig = {
      version: '1',
      roles: {
        relayer: { address: '0x1111111111111111111111111111111111111111' },
      },
      chains: {
        ethereum: {
          balances: {
            relayer: '1',
          },
        },
      },
    };

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger,
    });
    const recordFunderBalanceStub = sinon.stub(
      keyFunder as unknown as {
        recordFunderBalance: (chain: string) => Promise<void>;
      },
      'recordFunderBalance',
    );
    recordFunderBalanceStub.rejects(new Error('RPC failure'));

    const fundKeysStub = sinon.stub(
      keyFunder as unknown as {
        fundKeys: (chain: string, keys: unknown[]) => Promise<void>;
      },
      'fundKeys',
    );
    fundKeysStub.resolves();

    await keyFunder.fundChain('ethereum');

    sinon.assert.calledOnce(recordFunderBalanceStub);
    sinon.assert.calledOnce(fundKeysStub);
    expect(
      records.some(
        (record) =>
          record.msg === 'Failed to record funder balance metric, continuing' &&
          record.error !== undefined,
      ),
    ).to.be.true;
    expect(
      records.find((record) => record.msg === 'Chain funding completed')
        ?.durationSeconds,
    ).to.be.a('number');
  });

  it('should bridge to Arbitrum Orbit when child funder balance is below threshold', async () => {
    const childFunder = '0x1111111111111111111111111111111111111111';
    const parentSigner = Wallet.createRandom();
    const childProvider = {
      getBalance: sinon.stub().resolves(BigNumber.from(0)),
    } as unknown as ReturnType<MultiProvider['getProvider']>;
    const parentBalance = BigNumber.from(10).pow(18).mul(2);
    sinon.stub(parentSigner, 'getBalance').resolves(parentBalance);

    const multiProvider = sinon.createStubInstance(MultiProvider);
    multiProvider.getSignerAddress
      .withArgs('arbitrumorbit')
      .resolves(childFunder);
    multiProvider.getProvider.withArgs('arbitrumorbit').returns(childProvider);
    multiProvider.getSigner.withArgs('ethereum').returns(parentSigner);
    multiProvider.getTransactionOverrides.withArgs('ethereum').returns({});
    const bridgeReceipt: ContractReceipt = {
      to: childFunder,
      from: parentSigner.address,
      contractAddress: '',
      transactionIndex: 0,
      gasUsed: BigNumber.from(0),
      logsBloom: '',
      blockHash: '0xabc',
      transactionHash: '0xabc',
      logs: [],
      blockNumber: 1,
      confirmations: 1,
      cumulativeGasUsed: BigNumber.from(0),
      effectiveGasPrice: BigNumber.from(0),
      byzantium: true,
      type: 0,
      events: [],
    };
    multiProvider.handleTx.resolves(bridgeReceipt);
    multiProvider.tryGetExplorerTxUrl.returns(null);

    const depositEth = sinon.stub().resolves({ hash: '0xabc' });
    const config: KeyFunderConfig = {
      version: '1',
      roles: {},
      chains: {
        arbitrumorbit: {
          bridge: {
            type: BridgeType.ArbitrumOrbit,
            parentChain: 'ethereum',
            inbox: '0x000000000000000000000000000000000000006e',
            threshold: '0.5',
            targetBalance: '1',
          },
        },
      },
    };

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger: testLogger,
      arbitrumOrbitInboxFactory: () => ({ depositEth }),
    });
    const recordFunderBalanceStub = sinon
      .stub(
        keyFunder as unknown as {
          recordFunderBalance: (chain: string) => Promise<void>;
        },
        'recordFunderBalance',
      )
      .resolves();

    await keyFunder.fundChain('arbitrumorbit');

    sinon.assert.calledOnce(depositEth);
    expect(depositEth.firstCall.args[0].value.eq(BigNumber.from(10).pow(18))).to
      .be.true;
    expect(multiProvider.handleTx.calledWith('ethereum')).to.be.true;
    sinon.assert.calledOnce(recordFunderBalanceStub);
  });

  it('should skip Arbitrum Orbit bridge when child balance is sufficient', async () => {
    const childFunder = '0x1111111111111111111111111111111111111111';
    const childProvider = {
      getBalance: sinon.stub().resolves(BigNumber.from(10).pow(18)),
    } as unknown as ReturnType<MultiProvider['getProvider']>;

    const multiProvider = sinon.createStubInstance(MultiProvider);
    multiProvider.getSignerAddress
      .withArgs('arbitrumorbit')
      .resolves(childFunder);
    multiProvider.getProvider.withArgs('arbitrumorbit').returns(childProvider);

    const depositEth = sinon.stub();
    const config: KeyFunderConfig = {
      version: '1',
      roles: {},
      chains: {
        arbitrumorbit: {
          bridge: {
            type: BridgeType.ArbitrumOrbit,
            parentChain: 'ethereum',
            inbox: '0x000000000000000000000000000000000000006e',
            threshold: '0.5',
            targetBalance: '1',
          },
        },
      },
    };

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger: testLogger,
      arbitrumOrbitInboxFactory: () => ({ depositEth }),
    });
    sinon
      .stub(
        keyFunder as unknown as {
          recordFunderBalance: (chain: string) => Promise<void>;
        },
        'recordFunderBalance',
      )
      .resolves();

    await keyFunder.fundChain('arbitrumorbit');

    sinon.assert.notCalled(depositEth);
    expect(multiProvider.handleTx.called).to.be.false;
  });
});
