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
  const MALFORMED_ORIGIN_ROUTER =
    '0x9292929292929292929292929292929292929292';
  const TX = {
    to: '0x2222222222222222222222222222222222222222',
    data: '0x',
    chainId: 31338,
  };
  const signerBytes32 = `0x000000000000000000000000${SIGNER.slice(2)}` as const;
  const originRouterBytes32 =
    `0x000000000000000000000000${ORIGIN_ROUTER.slice(2)}` as const;
  const malformedOriginRouterBytes32 =
    `0x000000000000000000000000${MALFORMED_ORIGIN_ROUTER.slice(2)}` as const;

  async function resolveFromLogs(logs: any[]) {
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
              if (log?.__throwArgsGetter) {
                return {
                  get args() {
                    throw new Error('args getter should not crash ICA inference');
                  },
                };
              }
              if (log?.__parsedArgs) {
                return {
                  args: log.__parsedArgs,
                };
              }
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
      return batches[0].config.submitter as any;
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

    await resolveFromLogs([malformedGetterLog, validLog]);
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

    await resolveFromLogs([malformedGetterLog, validLog]);
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

    await resolveFromLogs([malformedGetterLog, validLog]);
  });

  it('ignores scientific-notation origin domains and uses latest valid ICA event', async () => {
    const validLog = {
      __validLog: true,
      topics: ['0xvalid'],
      data: '0x',
      blockNumber: 600,
      transactionIndex: 0,
      logIndex: 0,
    };
    const malformedDomainLog = {
      __parsedArgs: {
        origin: '3.1347e4',
        router: malformedOriginRouterBytes32,
        owner: signerBytes32,
        ism: ethersConstants.AddressZero,
      },
      topics: ['0xmalformed-scientific-origin-domain'],
      data: '0x',
      blockNumber: 601,
      transactionIndex: 0,
      logIndex: 0,
    };

    const inferredSubmitter = await resolveFromLogs([
      malformedDomainLog,
      validLog,
    ]);

    expect(
      inferredSubmitter.originInterchainAccountRouter.toLowerCase(),
    ).to.equal(ORIGIN_ROUTER.toLowerCase());
  });

  it('ignores overlong router bytes32 fields and uses next valid ICA event', async () => {
    const validLog = {
      __validLog: true,
      topics: ['0xvalid'],
      data: '0x',
      blockNumber: 610,
      transactionIndex: 0,
      logIndex: 0,
    };
    const malformedRouterLog = {
      __parsedArgs: {
        origin: 31347,
        router: `0x${'1'.repeat(5000)}`,
        owner: signerBytes32,
        ism: ethersConstants.AddressZero,
      },
      topics: ['0xmalformed-overlong-router-bytes32'],
      data: '0x',
      blockNumber: 611,
      transactionIndex: 0,
      logIndex: 0,
    };

    const inferredSubmitter = await resolveFromLogs([malformedRouterLog, validLog]);

    expect(
      inferredSubmitter.originInterchainAccountRouter.toLowerCase(),
    ).to.equal(ORIGIN_ROUTER.toLowerCase());
  });

  it('ignores null-byte owner bytes32 fields and uses next valid ICA event', async () => {
    const validLog = {
      __validLog: true,
      topics: ['0xvalid'],
      data: '0x',
      blockNumber: 620,
      transactionIndex: 0,
      logIndex: 0,
    };
    const malformedOwnerLog = {
      __parsedArgs: {
        origin: 31347,
        router: originRouterBytes32,
        owner: `${signerBytes32}\0`,
        ism: ethersConstants.AddressZero,
      },
      topics: ['0xmalformed-null-byte-owner-bytes32'],
      data: '0x',
      blockNumber: 621,
      transactionIndex: 0,
      logIndex: 0,
    };

    const inferredSubmitter = await resolveFromLogs([malformedOwnerLog, validLog]);

    expect(inferredSubmitter.owner.toLowerCase()).to.equal(SIGNER.toLowerCase());
  });

  it('ignores overlong ism fields and uses next valid ICA event', async () => {
    const validLog = {
      __validLog: true,
      topics: ['0xvalid'],
      data: '0x',
      blockNumber: 630,
      transactionIndex: 0,
      logIndex: 0,
    };
    const malformedIsmLog = {
      __parsedArgs: {
        origin: 31347,
        router: originRouterBytes32,
        owner: signerBytes32,
        ism: `0x${'f'.repeat(5000)}`,
      },
      topics: ['0xmalformed-overlong-ism'],
      data: '0x',
      blockNumber: 631,
      transactionIndex: 0,
      logIndex: 0,
    };

    const inferredSubmitter = await resolveFromLogs([malformedIsmLog, validLog]);

    expect(inferredSubmitter.owner.toLowerCase()).to.equal(SIGNER.toLowerCase());
  });

  it('ignores null-byte ism fields and uses next valid ICA event', async () => {
    const validLog = {
      __validLog: true,
      topics: ['0xvalid'],
      data: '0x',
      blockNumber: 635,
      transactionIndex: 0,
      logIndex: 0,
    };
    const malformedIsmLog = {
      __parsedArgs: {
        origin: 31347,
        router: originRouterBytes32,
        owner: signerBytes32,
        ism: `${ethersConstants.AddressZero}\0`,
      },
      topics: ['0xmalformed-null-byte-ism'],
      data: '0x',
      blockNumber: 636,
      transactionIndex: 0,
      logIndex: 0,
    };

    const inferredSubmitter = await resolveFromLogs([malformedIsmLog, validLog]);

    expect(inferredSubmitter.owner.toLowerCase()).to.equal(SIGNER.toLowerCase());
  });

  it('ignores throwing parseLog args getters and uses next valid ICA event', async () => {
    const validLog = {
      __validLog: true,
      topics: ['0xvalid'],
      data: '0x',
      blockNumber: 640,
      transactionIndex: 0,
      logIndex: 0,
    };
    const malformedArgsGetterLog = {
      __throwArgsGetter: true,
      topics: ['0xmalformed-throwing-args-getter'],
      data: '0x',
      blockNumber: 641,
      transactionIndex: 0,
      logIndex: 0,
    };

    const inferredSubmitter = await resolveFromLogs([
      malformedArgsGetterLog,
      validLog,
    ]);

    expect(inferredSubmitter.owner.toLowerCase()).to.equal(SIGNER.toLowerCase());
  });

  it('accepts boxed ICA parsed args fields', async () => {
    const boxedArgsLog = {
      __parsedArgs: {
        origin: new String('31347'),
        router: new String(originRouterBytes32),
        owner: new String(signerBytes32),
        ism: new String(ethersConstants.AddressZero),
      },
      topics: ['0xboxed-ica-args'],
      data: '0x',
      blockNumber: 650,
      transactionIndex: 0,
      logIndex: 0,
    };

    const inferredSubmitter = await resolveFromLogs([boxedArgsLog]);

    expect(inferredSubmitter.owner.toLowerCase()).to.equal(SIGNER.toLowerCase());
    expect(
      inferredSubmitter.originInterchainAccountRouter.toLowerCase(),
    ).to.equal(ORIGIN_ROUTER.toLowerCase());
  });
});

describe('resolveSubmitterBatchesForTransactions timelock log position getter fallback', () => {
  const CHAIN = 'anvil2';
  const SIGNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  const TX = {
    to: '0x1111111111111111111111111111111111111111',
    data: '0x',
    chainId: 31338,
  };

  async function resolveFromRoleLogs(malformedGrant: any) {
    const timelockOwner = '0x6767676767676767676767676767676767676767';
    const safeProposer = '0x7878787878787878787878787878787878787878';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      () =>
        ({
          owner: async () => timelockOwner,
        }) as any,
    );
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() !== safeProposer.toLowerCase()) {
          throw new Error('not safe');
        }
        return {
          getThreshold: async () => 1,
        } as any;
      });

    const validGrant = {
      topics: ['0xgrant-valid'],
      data: '0x',
      blockNumber: '1600',
      transactionIndex: '1',
      logIndex: '1',
    };
    const revoke = {
      topics: ['0xrevoke'],
      data: '0x',
      blockNumber: '1599',
      transactionIndex: '0',
      logIndex: '0',
    };

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (filter.topics?.[0] === 'RoleGranted') {
          return [validGrant, malformedGrant];
        }
        return [revoke];
      }),
    };

    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: (log: any) => {
            if (log?.__throwArgsGetter) {
              return {
                get args() {
                  throw new Error(
                    'args getter should not crash timelock role parsing',
                  );
                },
              };
            }
            return {
              args: {
                account: log?.__parsedAccount ?? safeProposer,
              },
            };
          },
        },
      } as any);

    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
      },
      registry: {
        getAddresses: async () => ({}),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.TIMELOCK_CONTROLLER,
      );
      expect(
        (batches[0].config.submitter as any).proposerSubmitter.type,
      ).to.equal(TxSubmitterType.GNOSIS_TX_BUILDER);
      expect(
        (
          batches[0].config.submitter as any
        ).proposerSubmitter.safeAddress.toLowerCase(),
      ).to.equal(safeProposer.toLowerCase());
      expect(provider.getLogs.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
    }
  }

  it('ignores blockNumber toString getter throws during timelock role ordering', async () => {
    await resolveFromRoleLogs({
      topics: ['0xgrant-malformed-block-number-getter'],
      data: '0x',
      blockNumber: {
        get toString() {
          throw new Error('blockNumber toString getter should not crash');
        },
      },
      transactionIndex: '0',
      logIndex: '0',
    });
  });

  it('ignores transactionIndex toString getter throws during timelock role ordering', async () => {
    await resolveFromRoleLogs({
      topics: ['0xgrant-malformed-transaction-index-getter'],
      data: '0x',
      blockNumber: '1600',
      transactionIndex: {
        get toString() {
          throw new Error('transactionIndex toString getter should not crash');
        },
      },
      logIndex: '0',
    });
  });

  it('ignores logIndex toString getter throws during timelock role ordering', async () => {
    await resolveFromRoleLogs({
      topics: ['0xgrant-malformed-log-index-getter'],
      data: '0x',
      blockNumber: '1600',
      transactionIndex: '0',
      logIndex: {
        get toString() {
          throw new Error('logIndex toString getter should not crash');
        },
      },
    });
  });

  it('ignores overlong timelock account fields during role ordering', async () => {
    await resolveFromRoleLogs({
      __parsedAccount: `0x${'3'.repeat(5000)}`,
      topics: ['0xgrant-malformed-overlong-account'],
      data: '0x',
      blockNumber: '1601',
      transactionIndex: '0',
      logIndex: '0',
    });
  });

  it('ignores throwing parseLog args getters during timelock role ordering', async () => {
    await resolveFromRoleLogs({
      __throwArgsGetter: true,
      topics: ['0xgrant-malformed-throwing-args-getter'],
      data: '0x',
      blockNumber: '1601',
      transactionIndex: '0',
      logIndex: '0',
    });
  });

  it('accepts boxed timelock account fields during role ordering', async () => {
    await resolveFromRoleLogs({
      __parsedAccount: new String('0x7878787878787878787878787878787878787878'),
      topics: ['0xgrant-boxed-account'],
      data: '0x',
      blockNumber: '1601',
      transactionIndex: '0',
      logIndex: '0',
    });
  });

  it('ignores null-byte timelock account fields during role ordering', async () => {
    await resolveFromRoleLogs({
      __parsedAccount: '0x7878787878787878787878787878787878787878\0',
      topics: ['0xgrant-null-byte-account'],
      data: '0x',
      blockNumber: '1601',
      transactionIndex: '0',
      logIndex: '0',
    });
  });
});
