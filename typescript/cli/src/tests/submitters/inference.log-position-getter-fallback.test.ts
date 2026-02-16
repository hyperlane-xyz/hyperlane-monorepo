import { expect } from 'chai';
import { constants as ethersConstants } from 'ethers';
import sinon from 'sinon';

import {
  ISafe__factory,
  InterchainAccountRouter__factory,
  Ownable__factory,
  TimelockController__factory,
} from '@hyperlane-xyz/core';
import { TxSubmitterType } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { resolveSubmitterBatchesForTransactions } from '../../submitters/inference.js';

describe('resolveSubmitterBatchesForTransactions log position getter fallback', () => {
  const CHAIN = 'anvil2';
  const ORIGIN_CHAIN = 'anvil3';
  const SIGNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  const ICA_OWNER = '0x8787878787878787878787878787878787878787';
  const DESTINATION_ROUTER = '0x9090909090909090909090909090909090909090';
  const ORIGIN_ROUTER = '0x9191919191919191919191919191919191919191';
  const TX = {
    to: '0x2222222222222222222222222222222222222222',
    data: '0x',
    chainId: 31338,
  };
  const signerBytes32 = `0x000000000000000000000000${SIGNER.slice(2)}` as const;
  const originRouterBytes32 =
    `0x000000000000000000000000${ORIGIN_ROUTER.slice(2)}` as const;

  async function resolveFromLogs(logs: any[], validLog: any) {
    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => ICA_OWNER,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));
    const provider = {
      getLogs: sinon.stub().resolves(logs),
    };
    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() !== DESTINATION_ROUTER.toLowerCase()) {
          throw new Error('unexpected router');
        }

        return {
          filters: {
            InterchainAccountCreated: (_accountAddress: string) => ({}),
          },
          interface: {
            parseLog: (log: any) => {
              return log?.__validLog === true
                ? {
                    args: {
                      origin: 31347,
                      router: originRouterBytes32,
                      owner: signerBytes32,
                      ism: ethersConstants.AddressZero,
                    },
                  }
                : {
                    args: {
                      origin: 999999,
                      router: originRouterBytes32,
                      owner: signerBytes32,
                      ism: ethersConstants.AddressZero,
                    },
                  };
            },
          },
        } as any;
      });

    const getSignerAddressStub = sinon.stub().resolves(SIGNER);
    const getChainNameStub = sinon.stub().callsFake((domainId: number) => {
      if (domainId === 31347) {
        return ORIGIN_CHAIN;
      }
      throw new Error(`unknown domain ${domainId}`);
    });
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: getSignerAddressStub,
        getProvider: () => provider,
        getChainName: getChainNameStub,
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: DESTINATION_ROUTER,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(ownableStub.callCount).to.equal(1);
      expect(provider.getLogs.callCount).to.equal(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal(ORIGIN_CHAIN);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  }

  it('ignores blockNumber toString getter throws during ICA event ordering', async () => {
    const validLog = {
      __validLog: true,
      topics: ['0xvalid'],
      data: '0x',
      blockNumber: 500,
      transactionIndex: 0,
      logIndex: 0,
    };
    const malformedGetterLog = {
      topics: ['0xmalformed-block-number-getter'],
      data: '0x',
      blockNumber: {
        get toString() {
          throw new Error('blockNumber toString getter should not crash ordering');
        },
      },
      transactionIndex: 999,
      logIndex: 999,
    };

    await resolveFromLogs([malformedGetterLog, validLog], validLog);
  });

  it('ignores transactionIndex toString getter throws during ICA event ordering', async () => {
    const validLog = {
      __validLog: true,
      topics: ['0xvalid'],
      data: '0x',
      blockNumber: 501,
      transactionIndex: 1,
      logIndex: 1,
    };
    const malformedGetterLog = {
      topics: ['0xmalformed-transaction-index-getter'],
      data: '0x',
      blockNumber: 501,
      transactionIndex: {
        get toString() {
          throw new Error(
            'transactionIndex toString getter should not crash ordering',
          );
        },
      },
      logIndex: 999,
    };

    await resolveFromLogs([malformedGetterLog, validLog], validLog);
  });

  it('ignores logIndex toString getter throws during ICA event ordering', async () => {
    const validLog = {
      __validLog: true,
      topics: ['0xvalid'],
      data: '0x',
      blockNumber: 502,
      transactionIndex: 2,
      logIndex: 2,
    };
    const malformedGetterLog = {
      topics: ['0xmalformed-log-index-getter'],
      data: '0x',
      blockNumber: 502,
      transactionIndex: 2,
      logIndex: {
        get toString() {
          throw new Error('logIndex toString getter should not crash ordering');
        },
      },
    };

    await resolveFromLogs([malformedGetterLog, validLog], validLog);
  });
});
