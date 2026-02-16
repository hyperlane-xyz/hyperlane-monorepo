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
import {
  getRuntimeFunctionValuesByLabel,
  resolveRuntimeFunctionProbeCases,
} from './inference.runtime-globals.js';

describe('resolveSubmitterBatchesForTransactions platform constructor probes', () => {
  const CHAIN = 'anvil2';
  const SIGNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  const TX = {
    to: '0x1111111111111111111111111111111111111111',
    data: '0x',
    chainId: 31338,
  };

  const runtimeFunctionValuesByLabel = getRuntimeFunctionValuesByLabel();

  const RAW_CONSTRUCTOR_CASES = [
    {
      label: 'broadcastchannel-constructor-object',
      directGetLogsCallCount: 4,
    },
    {
      label: 'crypto-constructor-object',
      directGetLogsCallCount: 4,
    },
    {
      label: 'cryptokey-constructor-object',
      directGetLogsCallCount: 4,
    },
    {
      label: 'subtlecrypto-constructor-object',
      directGetLogsCallCount: 4,
    },
    {
      label: 'messageevent-constructor-object',
      directGetLogsCallCount: 4,
    },
    {
      label: 'navigator-constructor-object',
      directGetLogsCallCount: 4,
    },
    {
      label: 'performanceentry-constructor-object',
      directGetLogsCallCount: 4,
    },
    {
      label: 'performancemark-constructor-object',
      directGetLogsCallCount: 4,
    },
    {
      label: 'performancemeasure-constructor-object',
      directGetLogsCallCount: 4,
    },
    {
      label: 'performanceobserver-constructor-object',
      directGetLogsCallCount: 4,
    },
    {
      label: 'performanceobserverentrylist-constructor-object',
      directGetLogsCallCount: 4,
    },
    {
      label: 'performanceresourcetiming-constructor-object',
      directGetLogsCallCount: 4,
    },
    {
      label: 'websocket-constructor-object',
      directGetLogsCallCount: 4,
    },
    {
      label: 'textencoderstream-constructor-object',
      directGetLogsCallCount: 4,
    },
    {
      label: 'textdecoderstream-constructor-object',
      directGetLogsCallCount: 4,
    },
    {
      label: 'readablebytestreamcontroller-constructor-object',
      directGetLogsCallCount: 4,
    },
    {
      label: 'readablestreambyobreader-constructor-object',
      directGetLogsCallCount: 4,
    },
    {
      label: 'readablestreambyobrequest-constructor-object',
      directGetLogsCallCount: 4,
    },
    {
      label: 'readablestreamdefaultcontroller-constructor-object',
      directGetLogsCallCount: 4,
    },
    {
      label: 'readablestreamdefaultreader-constructor-object',
      directGetLogsCallCount: 4,
    },
    {
      label: 'writablestreamdefaultcontroller-constructor-object',
      directGetLogsCallCount: 4,
    },
    {
      label: 'writablestreamdefaultwriter-constructor-object',
      directGetLogsCallCount: 4,
    },
    {
      label: 'transformstreamdefaultcontroller-constructor-object',
      directGetLogsCallCount: 4,
    },
  ] as const;

  const CONSTRUCTOR_CASES = resolveRuntimeFunctionProbeCases(
    RAW_CONSTRUCTOR_CASES,
    runtimeFunctionValuesByLabel,
  );

  const expectTimelockJsonRpcBatches = (batches: any[]) => {
    expect(batches).to.have.length(2);
    expect(batches[0].transactions).to.have.length(1);
    expect(batches[1].transactions).to.have.length(1);
    expect(batches[0].config.submitter.type).to.equal(
      TxSubmitterType.TIMELOCK_CONTROLLER,
    );
    expect(
      (batches[0].config.submitter as any).proposerSubmitter.type,
    ).to.equal(TxSubmitterType.JSON_RPC);
    expect(batches[1].config.submitter.type).to.equal(
      TxSubmitterType.TIMELOCK_CONTROLLER,
    );
    expect(
      (batches[1].config.submitter as any).proposerSubmitter.type,
    ).to.equal(TxSubmitterType.JSON_RPC);
  };

  const createDirectSetup = (
    constructorValue: Function,
    asyncTryGetSigner: boolean,
  ) => {
    const timelockOwnerA = '0xd6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d7';
    const timelockOwnerB = '0xd7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d8';
    const proposerIca = '0xd8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d8d9';
    const destinationRouterAddress =
      '0xd9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d9d0';
    const originRouterAddress = '0xe0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e1';

    const ownerByTarget: Record<string, string> = {
      '0x1111111111111111111111111111111111111111': timelockOwnerA,
      '0x4444444444444444444444444444444444444444': timelockOwnerB,
    };

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      (targetAddress: string) =>
        ({
          owner: async () => ownerByTarget[targetAddress.toLowerCase()],
        }) as any,
    );
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: (_log: unknown) => ({ args: { account: proposerIca } }),
        },
      } as any);
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
              proposerIca,
          } as any;
        }

        throw new Error('unexpected router');
      });

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        if (
          (filter.address === timelockOwnerA ||
            filter.address === timelockOwnerB) &&
          filter.topics?.[0] === 'RoleGranted'
        ) {
          return [{ topics: [], data: '0x' }];
        }
        return [];
      }),
    };

    let originSignerProbeCalls = 0;
    let originSignerAddressLookups = 0;
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async (chainName: string) => {
          if (chainName === CHAIN) return SIGNER;
          originSignerAddressLookups += 1;
          throw new Error(`unexpected signer lookup for ${chainName}`);
        },
        getProvider: () => provider,
        tryGetSigner: asyncTryGetSigner
          ? async (chainName: string) => {
              if (chainName === CHAIN) return {};
              originSignerProbeCalls += 1;
              return constructorValue;
            }
          : (chainName: string) => {
              if (chainName === CHAIN) return {};
              originSignerProbeCalls += 1;
              return constructorValue;
            },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
          anvil3: {
            interchainAccountRouter: originRouterAddress,
          },
        }),
      },
    } as any;

    return {
      context,
      provider,
      getOriginSignerProbeCalls: () => originSignerProbeCalls,
      getOriginSignerAddressLookups: () => originSignerAddressLookups,
      restore: () => {
        ownableStub.restore();
        safeStub.restore();
        timelockStub.restore();
        icaRouterStub.restore();
      },
    };
  };

  const createEventDerivedSetup = (
    constructorValue: Function,
    asyncTryGetSigner: boolean,
  ) => {
    const timelockOwnerA = '0xe1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e2';
    const timelockOwnerB = '0xe2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e3';
    const proposerIca = '0xe3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e4';
    const destinationRouterAddress =
      '0xe4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e5';
    const originOwner = SIGNER.toLowerCase();
    const originOwnerBytes32 =
      `0x000000000000000000000000${originOwner.slice(2)}` as const;
    const originRouterBytes32 =
      '0x000000000000000000000000e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e6';

    const ownerByTarget: Record<string, string> = {
      '0x1111111111111111111111111111111111111111': timelockOwnerA,
      '0x4444444444444444444444444444444444444444': timelockOwnerB,
    };

    const ownableStub = sinon.stub(Ownable__factory, 'connect').callsFake(
      (targetAddress: string) =>
        ({
          owner: async () => ownerByTarget[targetAddress.toLowerCase()],
        }) as any,
    );
    const safeStub = sinon
      .stub(ISafe__factory, 'connect')
      .throws(new Error('not safe'));
    const timelockStub = sinon
      .stub(TimelockController__factory, 'connect')
      .returns({
        getMinDelay: async () => 0,
        hasRole: async () => false,
        interface: {
          getEventTopic: (name: string) => name,
          parseLog: (_log: unknown) => ({ args: { account: proposerIca } }),
        },
      } as any);
    const icaRouterStub = sinon
      .stub(InterchainAccountRouter__factory, 'connect')
      .callsFake((address: string) => {
        if (address.toLowerCase() === destinationRouterAddress.toLowerCase()) {
          return {
            filters: {
              InterchainAccountCreated: (_accountAddress: string) => ({
                address: destinationRouterAddress,
              }),
            },
            interface: {
              parseLog: () => ({
                args: {
                  origin: 31347,
                  router: originRouterBytes32,
                  owner: originOwnerBytes32,
                  ism: ethersConstants.AddressZero,
                },
              }),
            },
          } as any;
        }

        throw new Error('unexpected router');
      });

    const provider = {
      getLogs: sinon.stub().callsFake(async (filter: any) => {
        const normalizedAddress =
          typeof filter.address === 'string'
            ? filter.address.toLowerCase()
            : filter.address;
        if (
          (normalizedAddress === timelockOwnerA.toLowerCase() ||
            normalizedAddress === timelockOwnerB.toLowerCase()) &&
          filter.topics?.[0] === 'RoleGranted'
        ) {
          return [{ topics: [], data: normalizedAddress }];
        }
        if (normalizedAddress === destinationRouterAddress.toLowerCase()) {
          return [{ topics: [], data: '0x' }];
        }
        return [];
      }),
    };

    let chainNameCalls = 0;
    let originSignerProbeCalls = 0;
    let originSignerAddressLookups = 0;
    const context = {
      multiProvider: {
        getProtocol: () => ProtocolType.Ethereum,
        getSignerAddress: async (chainName: string) => {
          if (chainName === CHAIN) return SIGNER;
          originSignerAddressLookups += 1;
          throw new Error(`unexpected signer lookup for ${chainName}`);
        },
        getProvider: () => provider,
        getChainName: (domainId: number) => {
          chainNameCalls += 1;
          if (domainId === 31347) return 'anvil3';
          throw new Error(`unknown domain ${domainId}`);
        },
        tryGetSigner: asyncTryGetSigner
          ? async (chainName: string) => {
              if (chainName === CHAIN) return {};
              originSignerProbeCalls += 1;
              return constructorValue;
            }
          : (chainName: string) => {
              if (chainName === CHAIN) return {};
              originSignerProbeCalls += 1;
              return constructorValue;
            },
      },
      registry: {
        getAddresses: async () => ({
          [CHAIN]: {
            interchainAccountRouter: destinationRouterAddress,
          },
        }),
      },
    } as any;

    return {
      context,
      provider,
      getOriginSignerProbeCalls: () => originSignerProbeCalls,
      getOriginSignerAddressLookups: () => originSignerAddressLookups,
      getChainNameCalls: () => chainNameCalls,
      restore: () => {
        ownableStub.restore();
        safeStub.restore();
        timelockStub.restore();
        icaRouterStub.restore();
      },
    };
  };

  CONSTRUCTOR_CASES.forEach(
    ({ label, constructorValue, directGetLogsCallCount }) => {
      it(`caches ${label} origin signer probes across timelock ICA inferences`, async () => {
        const setup = createDirectSetup(constructorValue, false);
        try {
          const batches = await resolveSubmitterBatchesForTransactions({
            chain: CHAIN,
            transactions: [
              {
                ...TX,
                to: '0x1111111111111111111111111111111111111111',
              } as any,
              {
                ...TX,
                to: '0x4444444444444444444444444444444444444444',
              } as any,
            ],
            context: setup.context,
          });
          expectTimelockJsonRpcBatches(batches);
          expect(setup.getOriginSignerProbeCalls()).to.equal(1);
          expect(setup.getOriginSignerAddressLookups()).to.equal(1);
          expect(setup.provider.getLogs.callCount).to.equal(
            directGetLogsCallCount,
          );
        } finally {
          setup.restore();
        }
      });

      it(`caches async ${label} origin signer probes across timelock ICA inferences`, async () => {
        const setup = createDirectSetup(constructorValue, true);
        try {
          const batches = await resolveSubmitterBatchesForTransactions({
            chain: CHAIN,
            transactions: [
              {
                ...TX,
                to: '0x1111111111111111111111111111111111111111',
              } as any,
              {
                ...TX,
                to: '0x4444444444444444444444444444444444444444',
              } as any,
            ],
            context: setup.context,
          });
          expectTimelockJsonRpcBatches(batches);
          expect(setup.getOriginSignerProbeCalls()).to.equal(1);
          expect(setup.getOriginSignerAddressLookups()).to.equal(1);
          expect(setup.provider.getLogs.callCount).to.equal(
            directGetLogsCallCount,
          );
        } finally {
          setup.restore();
        }
      });

      it(`caches event-derived ${label} origin signer probes across timelock ICA inferences`, async () => {
        const setup = createEventDerivedSetup(constructorValue, false);
        try {
          const batches = await resolveSubmitterBatchesForTransactions({
            chain: CHAIN,
            transactions: [
              {
                ...TX,
                to: '0x1111111111111111111111111111111111111111',
              } as any,
              {
                ...TX,
                to: '0x4444444444444444444444444444444444444444',
              } as any,
            ],
            context: setup.context,
          });
          expectTimelockJsonRpcBatches(batches);
          expect(setup.getOriginSignerProbeCalls()).to.equal(1);
          expect(setup.getOriginSignerAddressLookups()).to.equal(1);
          expect(setup.getChainNameCalls()).to.equal(1);
          expect(setup.provider.getLogs.callCount).to.equal(5);
        } finally {
          setup.restore();
        }
      });

      it(`caches event-derived async ${label} origin signer probes across timelock ICA inferences`, async () => {
        const setup = createEventDerivedSetup(constructorValue, true);
        try {
          const batches = await resolveSubmitterBatchesForTransactions({
            chain: CHAIN,
            transactions: [
              {
                ...TX,
                to: '0x1111111111111111111111111111111111111111',
              } as any,
              {
                ...TX,
                to: '0x4444444444444444444444444444444444444444',
              } as any,
            ],
            context: setup.context,
          });
          expectTimelockJsonRpcBatches(batches);
          expect(setup.getOriginSignerProbeCalls()).to.equal(1);
          expect(setup.getOriginSignerAddressLookups()).to.equal(1);
          expect(setup.getChainNameCalls()).to.equal(1);
          expect(setup.provider.getLogs.callCount).to.equal(5);
        } finally {
          setup.restore();
        }
      });
    },
  );
});
