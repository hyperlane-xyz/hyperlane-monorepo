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
  const ORIGIN_CHAIN_ALT = 'anvil4';
  const SIGNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  const ICA_OWNER = '0x8787878787878787878787878787878787878787';
  const DESTINATION_ROUTER = '0x9090909090909090909090909090909090909090';
  const ORIGIN_ROUTER = '0x9191919191919191919191919191919191919191';
  const ORIGIN_ROUTER_ALT = '0x9494949494949494949494949494949494949494';
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

  async function resolveFromLogs(
    logs: any[],
    options?: {
      getChainName?: (domainId: number) => unknown;
      expectedSubmitterType?: TxSubmitterType;
      expectedSubmitterChain?: string;
    },
  ) {
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
              if (log?.__returnParsedArgsDirect) {
                return log.__parsedArgs;
              }
              if (log?.__returnNullArgsWithDirectFields) {
                return {
                  args: null,
                  ...(log.__parsedArgs ?? {}),
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
      if (options?.getChainName) {
        return options.getChainName(domainId);
      }
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
      const expectedSubmitterType =
        options?.expectedSubmitterType ?? TxSubmitterType.INTERCHAIN_ACCOUNT;
      expect(batches[0].config.submitter.type).to.equal(
        expectedSubmitterType,
      );
      if (expectedSubmitterType === TxSubmitterType.INTERCHAIN_ACCOUNT) {
        expect((batches[0].config.submitter as any).chain).to.equal(
          options?.expectedSubmitterChain ?? ORIGIN_CHAIN,
        );
      }
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

  it('ignores blockNumber getter throws during ICA event ordering', async () => {
    const validLog = {
      __validLog: true,
      topics: ['0xvalid'],
      data: '0x',
      blockNumber: 503,
      transactionIndex: 3,
      logIndex: 3,
    };
    const malformedGetterLog = {
      topics: ['0xmalformed-block-number-property-getter'],
      data: '0x',
      get blockNumber() {
        throw new Error('blockNumber getter should not crash ordering');
      },
      transactionIndex: 999,
      logIndex: 999,
    };

    await resolveFromLogs([malformedGetterLog, validLog]);
  });

  it('ignores transactionIndex getter throws during ICA event ordering', async () => {
    const validLog = {
      __validLog: true,
      topics: ['0xvalid'],
      data: '0x',
      blockNumber: 504,
      transactionIndex: 4,
      logIndex: 4,
    };
    const malformedGetterLog = {
      topics: ['0xmalformed-transaction-index-property-getter'],
      data: '0x',
      blockNumber: 504,
      get transactionIndex() {
        throw new Error('transactionIndex getter should not crash ordering');
      },
      logIndex: 999,
    };

    await resolveFromLogs([malformedGetterLog, validLog]);
  });

  it('ignores logIndex getter throws during ICA event ordering', async () => {
    const validLog = {
      __validLog: true,
      topics: ['0xvalid'],
      data: '0x',
      blockNumber: 505,
      transactionIndex: 5,
      logIndex: 5,
    };
    const malformedGetterLog = {
      topics: ['0xmalformed-log-index-property-getter'],
      data: '0x',
      blockNumber: 505,
      transactionIndex: 5,
      get logIndex() {
        throw new Error('logIndex getter should not crash ordering');
      },
    };

    await resolveFromLogs([malformedGetterLog, validLog]);
  });

  it('falls back to jsonRpc when registry destination router is overlong string', async () => {
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
      getLogs: sinon.stub().throws(new Error('getLogs should not run')),
    };
    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .throws(new Error('ICA router connect should not run'));
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: () => ORIGIN_CHAIN,
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: `0x${'1'.repeat(5000)}`,
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
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(provider.getLogs.callCount).to.equal(0);
      expect(icaRouterStub.callCount).to.equal(0);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('falls back to jsonRpc when registry destination router contains null byte', async () => {
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
      getLogs: sinon.stub().throws(new Error('getLogs should not run')),
    };
    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .throws(new Error('ICA router connect should not run'));
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: () => ORIGIN_CHAIN,
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: `${DESTINATION_ROUTER}\0`,
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
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(provider.getLogs.callCount).to.equal(0);
      expect(icaRouterStub.callCount).to.equal(0);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('falls back to jsonRpc when registry destination router getter throws', async () => {
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
      getLogs: sinon.stub().throws(new Error('getLogs should not run')),
    };
    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .throws(new Error('ICA router connect should not run'));
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: () => ORIGIN_CHAIN,
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            get interchainAccountRouter() {
              throw new Error(
                'destination router getter should not crash inference',
              );
            },
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
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(provider.getLogs.callCount).to.equal(0);
      expect(icaRouterStub.callCount).to.equal(0);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('falls back to jsonRpc when registry destination router only exists on prototype', async () => {
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
      getLogs: sinon.stub().throws(new Error('getLogs should not run')),
    };
    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .throws(new Error('ICA router connect should not run'));
    const destinationAddresses = Object.create({
      interchainAccountRouter: DESTINATION_ROUTER,
    });
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: () => ORIGIN_CHAIN,
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: destinationAddresses,
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
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(provider.getLogs.callCount).to.equal(0);
      expect(icaRouterStub.callCount).to.equal(0);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('falls back to jsonRpc when registry getAddresses returns non-object payload', async () => {
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
      getLogs: sinon.stub().throws(new Error('getLogs should not run')),
    };
    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .throws(new Error('ICA router connect should not run'));
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: () => ORIGIN_CHAIN,
      },
      registry: {
        getAddresses: async () => 'not-an-object',
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(provider.getLogs.callCount).to.equal(0);
      expect(icaRouterStub.callCount).to.equal(0);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('falls back to jsonRpc when registry getAddresses entries enumeration throws', async () => {
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
      getLogs: sinon.stub().throws(new Error('getLogs should not run')),
    };
    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .throws(new Error('ICA router connect should not run'));
    const registryPayload = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('registry entries ownKeys should not crash inference');
        },
      },
    );
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        getChainName: () => ORIGIN_CHAIN,
      },
      registry: {
        getAddresses: async () => registryPayload,
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [TX as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(provider.getLogs.callCount).to.equal(0);
      expect(icaRouterStub.callCount).to.equal(0);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('skips throwing registry chain entry getters and still infers fallback ICA from valid entries', async () => {
    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => ICA_OWNER,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));
    const destinationProvider = {
      getLogs: sinon.stub().resolves([]),
    };
    const originProvider = {};
    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === DESTINATION_ROUTER.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
            interface: {
              parseLog: () => {
                throw new Error('no logs should be parsed');
              },
            },
          } as any;
        }
        if (address.toLowerCase() === ORIGIN_ROUTER_ALT.toLowerCase()) {
          return {
            'getRemoteInterchainAccount(address,address,address)': async () =>
              ICA_OWNER,
          } as any;
        }
        throw new Error(`unexpected router ${address}`);
      });
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: (chain: string) =>
          chain === CHAIN ? destinationProvider : originProvider,
        getChainName: () => ORIGIN_CHAIN_ALT,
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: DESTINATION_ROUTER,
          },
          get [ORIGIN_CHAIN]() {
            throw new Error(
              'chain entry getter should not abort registry normalization',
            );
          },
          [ORIGIN_CHAIN_ALT]: {
            interchainAccountRouter: ORIGIN_ROUTER_ALT,
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
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal(
        ORIGIN_CHAIN_ALT,
      );
      expect(destinationProvider.getLogs.callCount).to.equal(1);
      expect(icaRouterStub.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('skips disallowed prototype chain keys in registry entries and still infers fallback ICA from valid entries', async () => {
    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => ICA_OWNER,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));
    const destinationProvider = {
      getLogs: sinon.stub().resolves([]),
    };
    const originProvider = {};
    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === DESTINATION_ROUTER.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
            interface: {
              parseLog: () => {
                throw new Error('no logs should be parsed');
              },
            },
          } as any;
        }
        if (address.toLowerCase() === ORIGIN_ROUTER_ALT.toLowerCase()) {
          return {
            'getRemoteInterchainAccount(address,address,address)': async () =>
              ICA_OWNER,
          } as any;
        }
        throw new Error(`unexpected router ${address}`);
      });
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: (chain: string) =>
          chain === CHAIN ? destinationProvider : originProvider,
        getChainName: () => ORIGIN_CHAIN_ALT,
      },
      registry: {
        getAddresses: async () => {
          const payload: Record<string, unknown> = {
            [CHAIN]: {
              interchainAccountRouter: DESTINATION_ROUTER,
            },
            [ORIGIN_CHAIN_ALT]: {
              interchainAccountRouter: ORIGIN_ROUTER_ALT,
            },
          };
          Object.defineProperty(payload, '__proto__', {
            enumerable: true,
            configurable: true,
            value: {
              interchainAccountRouter:
                '0x9393939393939393939393939393939393939393',
            },
          });
          return payload;
        },
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
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal(
        ORIGIN_CHAIN_ALT,
      );
      expect(destinationProvider.getLogs.callCount).to.equal(1);
      expect(icaRouterStub.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('skips throwing origin registry router getters and still infers fallback ICA from later origins', async () => {
    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => ICA_OWNER,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));
    const destinationProvider = {
      getLogs: sinon.stub().resolves([]),
    };
    const originProvider = {};
    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === DESTINATION_ROUTER.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
            interface: {
              parseLog: () => {
                throw new Error('no logs should be parsed');
              },
            },
          } as any;
        }
        if (address.toLowerCase() === ORIGIN_ROUTER_ALT.toLowerCase()) {
          return {
            'getRemoteInterchainAccount(address,address,address)': async () =>
              ICA_OWNER,
          } as any;
        }
        throw new Error(`unexpected router ${address}`);
      });
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: (chain: string) =>
          chain === CHAIN ? destinationProvider : originProvider,
        getChainName: () => ORIGIN_CHAIN_ALT,
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: DESTINATION_ROUTER,
          },
          [ORIGIN_CHAIN]: {
            get interchainAccountRouter() {
              throw new Error(
                'origin router getter should not abort fallback derivation',
              );
            },
          },
          [ORIGIN_CHAIN_ALT]: {
            interchainAccountRouter: ORIGIN_ROUTER_ALT,
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
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal(
        ORIGIN_CHAIN_ALT,
      );
      expect(destinationProvider.getLogs.callCount).to.equal(1);
      expect(icaRouterStub.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
  });

  it('skips inherited origin registry routers and still infers fallback ICA from later origins', async () => {
    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => ICA_OWNER,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));
    const destinationProvider = {
      getLogs: sinon.stub().resolves([]),
    };
    const originProvider = {};
    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === DESTINATION_ROUTER.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
            interface: {
              parseLog: () => {
                throw new Error('no logs should be parsed');
              },
            },
          } as any;
        }
        if (address.toLowerCase() === ORIGIN_ROUTER_ALT.toLowerCase()) {
          return {
            'getRemoteInterchainAccount(address,address,address)': async () =>
              ICA_OWNER,
          } as any;
        }
        throw new Error(`unexpected router ${address}`);
      });
    const inheritedOriginAddresses = Object.create({
      interchainAccountRouter: ORIGIN_ROUTER,
    });
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: (chain: string) =>
          chain === CHAIN ? destinationProvider : originProvider,
        getChainName: () => ORIGIN_CHAIN_ALT,
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: DESTINATION_ROUTER,
          },
          [ORIGIN_CHAIN]: inheritedOriginAddresses,
          [ORIGIN_CHAIN_ALT]: {
            interchainAccountRouter: ORIGIN_ROUTER_ALT,
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
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal(
        ORIGIN_CHAIN_ALT,
      );
      expect(destinationProvider.getLogs.callCount).to.equal(1);
      expect(icaRouterStub.callCount).to.equal(2);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
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

  it('ignores router bytes32 boxed values with throwing toString and uses next valid ICA event', async () => {
    const validLog = {
      __validLog: true,
      topics: ['0xvalid'],
      data: '0x',
      blockNumber: 625,
      transactionIndex: 0,
      logIndex: 0,
    };
    const throwingBoxedRouter = new String(originRouterBytes32) as any;
    throwingBoxedRouter.toString = () => {
      throw new Error('router boxed toString should not crash ICA parsing');
    };
    const malformedRouterLog = {
      __parsedArgs: {
        origin: 31347,
        router: throwingBoxedRouter,
        owner: signerBytes32,
        ism: ethersConstants.AddressZero,
      },
      topics: ['0xmalformed-throwing-boxed-router'],
      data: '0x',
      blockNumber: 626,
      transactionIndex: 0,
      logIndex: 0,
    };

    const inferredSubmitter = await resolveFromLogs([malformedRouterLog, validLog]);

    expect(
      inferredSubmitter.originInterchainAccountRouter.toLowerCase(),
    ).to.equal(ORIGIN_ROUTER.toLowerCase());
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

  it('accepts positional ICA parsed args when named fields are missing', async () => {
    const positionalArgs = [] as any[];
    positionalArgs[1] = 31347;
    positionalArgs[2] = originRouterBytes32;
    positionalArgs[3] = signerBytes32;
    positionalArgs[4] = ethersConstants.AddressZero;

    const inferredSubmitter = await resolveFromLogs([
      {
        __parsedArgs: positionalArgs,
        topics: ['0xpositional-ica-args'],
        data: '0x',
        blockNumber: 651,
        transactionIndex: 0,
        logIndex: 0,
      },
    ]);

    expect(inferredSubmitter.owner.toLowerCase()).to.equal(SIGNER.toLowerCase());
    expect(
      inferredSubmitter.originInterchainAccountRouter.toLowerCase(),
    ).to.equal(ORIGIN_ROUTER.toLowerCase());
  });

  it('falls back to positional ICA parsed args when named getter throws', async () => {
    const positionalArgs = [] as any[];
    positionalArgs[1] = 31347;
    positionalArgs[2] = originRouterBytes32;
    positionalArgs[3] = signerBytes32;
    positionalArgs[4] = ethersConstants.AddressZero;
    Object.defineProperty(positionalArgs, 'origin', {
      get() {
        throw new Error('named origin getter should not block positional fallback');
      },
      enumerable: true,
      configurable: true,
    });

    const inferredSubmitter = await resolveFromLogs([
      {
        __parsedArgs: positionalArgs,
        topics: ['0xpositional-ica-args-getter-throw'],
        data: '0x',
        blockNumber: 652,
        transactionIndex: 0,
        logIndex: 0,
      },
    ]);

    expect(inferredSubmitter.owner.toLowerCase()).to.equal(SIGNER.toLowerCase());
    expect(
      inferredSubmitter.originInterchainAccountRouter.toLowerCase(),
    ).to.equal(ORIGIN_ROUTER.toLowerCase());
  });

  it('accepts direct ICA parsed args objects when parseLog returns args payload directly', async () => {
    const inferredSubmitter = await resolveFromLogs([
      {
        __returnParsedArgsDirect: true,
        __parsedArgs: {
          origin: 31347,
          router: originRouterBytes32,
          owner: signerBytes32,
          ism: ethersConstants.AddressZero,
        },
        topics: ['0xdirect-ica-args-object'],
        data: '0x',
        blockNumber: 653,
        transactionIndex: 0,
        logIndex: 0,
      },
    ]);

    expect(inferredSubmitter.owner.toLowerCase()).to.equal(SIGNER.toLowerCase());
    expect(
      inferredSubmitter.originInterchainAccountRouter.toLowerCase(),
    ).to.equal(ORIGIN_ROUTER.toLowerCase());
  });

  it('accepts direct positional ICA parsed args when parseLog returns tuple payload directly', async () => {
    const positionalArgs = [] as any[];
    positionalArgs[1] = 31347;
    positionalArgs[2] = originRouterBytes32;
    positionalArgs[3] = signerBytes32;
    positionalArgs[4] = ethersConstants.AddressZero;

    const inferredSubmitter = await resolveFromLogs([
      {
        __returnParsedArgsDirect: true,
        __parsedArgs: positionalArgs,
        topics: ['0xdirect-ica-positional-args'],
        data: '0x',
        blockNumber: 654,
        transactionIndex: 0,
        logIndex: 0,
      },
    ]);

    expect(inferredSubmitter.owner.toLowerCase()).to.equal(SIGNER.toLowerCase());
    expect(
      inferredSubmitter.originInterchainAccountRouter.toLowerCase(),
    ).to.equal(ORIGIN_ROUTER.toLowerCase());
  });

  it('ignores boxed-string ICA parseLog payloads and uses next valid ICA event', async () => {
    const validLog = {
      __validLog: true,
      topics: ['0xvalid'],
      data: '0x',
      blockNumber: 640,
      transactionIndex: 0,
      logIndex: 0,
    };
    const malformedParsedPayloadLog = {
      __returnParsedArgsDirect: true,
      __parsedArgs: new String('malformed-ica-payload'),
      topics: ['0xmalformed-boxed-string-direct-payload'],
      data: '0x',
      blockNumber: 641,
      transactionIndex: 0,
      logIndex: 0,
    };

    const inferredSubmitter = await resolveFromLogs([
      malformedParsedPayloadLog,
      validLog,
    ]);

    expect(
      inferredSubmitter.originInterchainAccountRouter.toLowerCase(),
    ).to.equal(ORIGIN_ROUTER.toLowerCase());
  });

  it('ignores inherited ICA parseLog fields and uses next valid ICA event', async () => {
    const validLog = {
      __validLog: true,
      topics: ['0xvalid'],
      data: '0x',
      blockNumber: 642,
      transactionIndex: 0,
      logIndex: 0,
    };
    const inheritedArgs = Object.create({
      origin: 31347,
      router: malformedOriginRouterBytes32,
      owner: signerBytes32,
      ism: ethersConstants.AddressZero,
    });
    const malformedParsedPayloadLog = {
      __returnParsedArgsDirect: true,
      __parsedArgs: inheritedArgs,
      topics: ['0xmalformed-inherited-direct-payload'],
      data: '0x',
      blockNumber: 643,
      transactionIndex: 0,
      logIndex: 0,
    };

    const inferredSubmitter = await resolveFromLogs([
      malformedParsedPayloadLog,
      validLog,
    ]);

    expect(
      inferredSubmitter.originInterchainAccountRouter.toLowerCase(),
    ).to.equal(ORIGIN_ROUTER.toLowerCase());
  });

  it('accepts direct ICA parsed fields when parseLog args is null', async () => {
    const inferredSubmitter = await resolveFromLogs([
      {
        __returnNullArgsWithDirectFields: true,
        __parsedArgs: {
          origin: 31347,
          router: originRouterBytes32,
          owner: signerBytes32,
          ism: ethersConstants.AddressZero,
        },
        topics: ['0xdirect-ica-fields-with-null-args'],
        data: '0x',
        blockNumber: 655,
        transactionIndex: 0,
        logIndex: 0,
      },
    ]);

    expect(inferredSubmitter.owner.toLowerCase()).to.equal(SIGNER.toLowerCase());
    expect(
      inferredSubmitter.originInterchainAccountRouter.toLowerCase(),
    ).to.equal(ORIGIN_ROUTER.toLowerCase());
  });

  it('accepts boxed chain names from domain lookup during ICA event inference', async () => {
    const inferredSubmitter = await resolveFromLogs(
      [
        {
          __validLog: true,
          topics: ['0xboxed-chain-name'],
          data: '0x',
          blockNumber: 656,
          transactionIndex: 0,
          logIndex: 0,
        },
      ],
      {
        getChainName: (domainId: number) => {
          if (domainId === 31347) {
            return new String(` ${ORIGIN_CHAIN} `);
          }
          throw new Error(`unknown domain ${domainId}`);
        },
        expectedSubmitterChain: ORIGIN_CHAIN,
      },
    );

    expect(inferredSubmitter.chain).to.equal(ORIGIN_CHAIN);
  });

  it('falls back to jsonRpc when domain lookup returns overlong chain name', async () => {
    const inferredSubmitter = await resolveFromLogs(
      [
        {
          __validLog: true,
          topics: ['0xoverlong-chain-name'],
          data: '0x',
          blockNumber: 657,
          transactionIndex: 0,
          logIndex: 0,
        },
      ],
      {
        getChainName: () => 'x'.repeat(5000),
        expectedSubmitterType: TxSubmitterType.JSON_RPC,
      },
    );

    expect(inferredSubmitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('falls back to jsonRpc when domain lookup returns null-byte chain name', async () => {
    const inferredSubmitter = await resolveFromLogs(
      [
        {
          __validLog: true,
          topics: ['0xnull-byte-chain-name'],
          data: '0x',
          blockNumber: 658,
          transactionIndex: 0,
          logIndex: 0,
        },
      ],
      {
        getChainName: () => `${ORIGIN_CHAIN}\0`,
        expectedSubmitterType: TxSubmitterType.JSON_RPC,
      },
    );

    expect(inferredSubmitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('falls back to jsonRpc when domain lookup returns boxed chain name with throwing toString', async () => {
    const boxedChainName = new String(ORIGIN_CHAIN) as any;
    boxedChainName.toString = () => {
      throw new Error('chain-name toString should not crash domain lookup');
    };
    const inferredSubmitter = await resolveFromLogs(
      [
        {
          __validLog: true,
          topics: ['0xthrowing-boxed-chain-name'],
          data: '0x',
          blockNumber: 659,
          transactionIndex: 0,
          logIndex: 0,
        },
      ],
      {
        getChainName: () => boxedChainName,
        expectedSubmitterType: TxSubmitterType.JSON_RPC,
      },
    );

    expect(inferredSubmitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('falls back to jsonRpc when domain lookup returns boxed chain name with non-string toString result', async () => {
    const boxedChainName = new String(ORIGIN_CHAIN) as any;
    boxedChainName.toString = () => ({ trim: () => ORIGIN_CHAIN }) as any;
    const inferredSubmitter = await resolveFromLogs(
      [
        {
          __validLog: true,
          topics: ['0xnon-string-boxed-chain-name'],
          data: '0x',
          blockNumber: 660,
          transactionIndex: 0,
          logIndex: 0,
        },
      ],
      {
        getChainName: () => boxedChainName,
        expectedSubmitterType: TxSubmitterType.JSON_RPC,
      },
    );

    expect(inferredSubmitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('falls back to jsonRpc when domain lookup returns disallowed prototype chain name', async () => {
    const inferredSubmitter = await resolveFromLogs(
      [
        {
          __validLog: true,
          topics: ['0xdisallowed-domain-chain-name'],
          data: '0x',
          blockNumber: 661,
          transactionIndex: 0,
          logIndex: 0,
        },
      ],
      {
        getChainName: () => '__proto__',
        expectedSubmitterType: TxSubmitterType.JSON_RPC,
      },
    );

    expect(inferredSubmitter.type).to.equal(TxSubmitterType.JSON_RPC);
  });

  it('infers ICA fallback derivation when origin protocol is uppercase string', async () => {
    const inferredIcaOwner = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const destinationRouterAddress =
      '0x9999999999999999999999999999999999999999';
    const originRouterAddress = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    const ownableStub = sinon.stub(Ownable__factory, 'connect').returns({
      owner: async () => inferredIcaOwner,
    } as any);
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .throws(new Error('not timelock'));

    const provider = {
      getLogs: sinon.stub().resolves([]),
    };

    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === destinationRouterAddress.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({}),
            },
          } as any;
        }

        if (address.toLowerCase() === originRouterAddress.toLowerCase()) {
          return {
            ['getRemoteInterchainAccount(address,address,address)']: async () =>
              inferredIcaOwner,
          } as any;
        }

        throw new Error('unexpected router');
      });

    const context = {
      multiProvider: {
        getProtocol: (chainName: string) =>
          chainName === ORIGIN_CHAIN ? (' ETHEREUM ' as any) : ProtocolType.Ethereum,
        getSignerAddress: async () => SIGNER,
        getProvider: () => provider,
        tryGetSigner: () => ({}),
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
          [ORIGIN_CHAIN]: {
            interchainAccountRouter: originRouterAddress,
          },
        }),
      },
    } as any;

    try {
      const batches = await resolveSubmitterBatchesForTransactions({
        chain: CHAIN,
        transactions: [{ ...TX, to: inferredIcaOwner } as any],
        context,
      });

      expect(batches).to.have.length(1);
      expect(batches[0].config.submitter.type).to.equal(
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect((batches[0].config.submitter as any).chain).to.equal(ORIGIN_CHAIN);
      expect(provider.getLogs.callCount).to.equal(1);
    } finally {
      ownableStub.restore();
      safeStub.restore();
      timelockStub.restore();
      icaRouterStub.restore();
    }
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
            if (log?.__returnParsedArgsDirect) {
              return log.__parsedArgs;
            }
            if (log?.__returnNullArgsWithDirectFields) {
              return {
                args: null,
                ...(log.__parsedArgs ?? {}),
              };
            }
            if (log?.__parsedArgs) {
              return {
                args: log.__parsedArgs,
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

  it('ignores blockNumber getter throws during timelock role ordering', async () => {
    await resolveFromRoleLogs({
      topics: ['0xgrant-malformed-block-number-property-getter'],
      data: '0x',
      get blockNumber() {
        throw new Error('blockNumber getter should not crash');
      },
      transactionIndex: '0',
      logIndex: '0',
    });
  });

  it('ignores transactionIndex getter throws during timelock role ordering', async () => {
    await resolveFromRoleLogs({
      topics: ['0xgrant-malformed-transaction-index-property-getter'],
      data: '0x',
      blockNumber: '1600',
      get transactionIndex() {
        throw new Error('transactionIndex getter should not crash');
      },
      logIndex: '0',
    });
  });

  it('ignores logIndex getter throws during timelock role ordering', async () => {
    await resolveFromRoleLogs({
      topics: ['0xgrant-malformed-log-index-property-getter'],
      data: '0x',
      blockNumber: '1600',
      transactionIndex: '0',
      get logIndex() {
        throw new Error('logIndex getter should not crash');
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

  it('ignores boxed timelock account values with throwing toString during role ordering', async () => {
    const throwingBoxedAccount = new String(
      '0x7878787878787878787878787878787878787878',
    ) as any;
    throwingBoxedAccount.toString = () => {
      throw new Error('account boxed toString should not crash role parsing');
    };
    await resolveFromRoleLogs({
      __parsedAccount: throwingBoxedAccount,
      topics: ['0xgrant-throwing-boxed-account'],
      data: '0x',
      blockNumber: '1601',
      transactionIndex: '0',
      logIndex: '0',
    });
  });

  it('accepts positional timelock account fields during role ordering', async () => {
    const positionalArgs = [] as any[];
    positionalArgs[1] = '0x7878787878787878787878787878787878787878';

    await resolveFromRoleLogs({
      __parsedArgs: positionalArgs,
      topics: ['0xgrant-positional-account'],
      data: '0x',
      blockNumber: '1601',
      transactionIndex: '0',
      logIndex: '0',
    });
  });

  it('falls back to positional timelock account fields when named getter throws', async () => {
    const positionalArgs = [] as any[];
    positionalArgs[1] = '0x7878787878787878787878787878787878787878';
    Object.defineProperty(positionalArgs, 'account', {
      get() {
        throw new Error(
          'named account getter should not block positional fallback',
        );
      },
      enumerable: true,
      configurable: true,
    });

    await resolveFromRoleLogs({
      __parsedArgs: positionalArgs,
      topics: ['0xgrant-positional-account-getter-throw'],
      data: '0x',
      blockNumber: '1601',
      transactionIndex: '0',
      logIndex: '0',
    });
  });

  it('accepts direct timelock account args objects when parseLog returns args payload directly', async () => {
    await resolveFromRoleLogs({
      __returnParsedArgsDirect: true,
      __parsedArgs: {
        account: '0x7878787878787878787878787878787878787878',
      },
      topics: ['0xgrant-direct-account-object'],
      data: '0x',
      blockNumber: '1601',
      transactionIndex: '0',
      logIndex: '0',
    });
  });

  it('accepts direct positional timelock account args when parseLog returns tuple payload directly', async () => {
    const positionalArgs = [] as any[];
    positionalArgs[1] = '0x7878787878787878787878787878787878787878';
    await resolveFromRoleLogs({
      __returnParsedArgsDirect: true,
      __parsedArgs: positionalArgs,
      topics: ['0xgrant-direct-positional-account'],
      data: '0x',
      blockNumber: '1601',
      transactionIndex: '0',
      logIndex: '0',
    });
  });

  it('ignores boxed-string timelock parseLog payloads during role ordering', async () => {
    await resolveFromRoleLogs({
      __returnParsedArgsDirect: true,
      __parsedArgs: new String('malformed-timelock-payload'),
      topics: ['0xgrant-direct-boxed-string-account'],
      data: '0x',
      blockNumber: '1601',
      transactionIndex: '0',
      logIndex: '0',
    });
  });

  it('ignores inherited timelock parseLog fields during role ordering', async () => {
    await resolveFromRoleLogs({
      __returnParsedArgsDirect: true,
      __parsedArgs: Object.create({
        account: SIGNER,
      }),
      topics: ['0xgrant-direct-inherited-account'],
      data: '0x',
      blockNumber: '1598',
      transactionIndex: '0',
      logIndex: '0',
    });
  });

  it('accepts direct timelock account fields when parseLog args is null', async () => {
    await resolveFromRoleLogs({
      __returnNullArgsWithDirectFields: true,
      __parsedArgs: {
        account: '0x7878787878787878787878787878787878787878',
      },
      topics: ['0xgrant-direct-account-with-null-args'],
      data: '0x',
      blockNumber: '1601',
      transactionIndex: '0',
      logIndex: '0',
    });
  });
});
