import { execFileSync } from 'child_process';

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

describe('resolveSubmitterBatchesForTransactions primitive global probes', () => {
  const CHAIN = 'anvil2';
  const SIGNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  const TX = {
    to: '0x1111111111111111111111111111111111111111',
    data: '0x',
    chainId: 31338,
  };

  const baselinePrimitiveLabels = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '-e',
        `
          const labels = Object.getOwnPropertyNames(globalThis)
            .filter((name) => {
              const value = globalThis[name];
              return ['string', 'number', 'boolean', 'bigint', 'undefined'].includes(
                typeof value,
              );
            })
            .map((name) => \`\${name.toLowerCase()}-\${typeof globalThis[name]}-primitive\`)
            .sort();
          process.stdout.write(JSON.stringify(labels));
        `,
      ],
      { encoding: 'utf8' },
    ),
  ) as string[];

  const runtimePrimitiveByLabel = new Map<string, any>();
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    const value = (globalThis as any)[name];
    const valueType = typeof value;
    if (['string', 'number', 'boolean', 'bigint', 'undefined'].includes(valueType)) {
      runtimePrimitiveByLabel.set(`${name.toLowerCase()}-${valueType}-primitive`, value);
    }
  }

  const fallbackPrimitiveFromLabel = (label: string): unknown => {
    if (label.endsWith('-undefined-primitive')) return undefined;
    if (label.endsWith('-number-primitive')) {
      if (label.startsWith('infinity-')) return Number.POSITIVE_INFINITY;
      if (label.startsWith('nan-')) return Number.NaN;
      return 0;
    }
    if (label.endsWith('-boolean-primitive')) return false;
    if (label.endsWith('-bigint-primitive')) return 0n;
    if (label.endsWith('-string-primitive')) return label;
    return undefined;
  };

  const PROBE_CASES = baselinePrimitiveLabels.map((label) => ({
    label,
    probeValue:
      runtimePrimitiveByLabel.get(label) ?? fallbackPrimitiveFromLabel(label),
    expectedOriginSignerAddressLookups:
      label === 'nan-number-primitive' || label === 'undefined-undefined-primitive'
        ? 0
        : 1,
  }));

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

  const createDirectSetup = (probeValue: unknown, asyncTryGetSigner: boolean) => {
    const timelockOwnerA = '0x4141414141414141414141414141414141414142';
    const timelockOwnerB = '0x4242424242424242424242424242424242424243';
    const proposerIca = '0x4343434343434343434343434343434343434344';
    const destinationRouterAddress =
      '0x4444444444444444444444444444444444444445';
    const originRouterAddress = '0x4545454545454545454545454545454545454546';

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
              return probeValue;
            }
          : (chainName: string) => {
              if (chainName === CHAIN) return {};
              originSignerProbeCalls += 1;
              return probeValue;
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
    probeValue: unknown,
    asyncTryGetSigner: boolean,
  ) => {
    const timelockOwnerA = '0x4646464646464646464646464646464646464647';
    const timelockOwnerB = '0x4747474747474747474747474747474747474748';
    const proposerIca = '0x4848484848484848484848484848484848484849';
    const destinationRouterAddress =
      '0x4949494949494949494949494949494949494950';
    const originOwner = SIGNER.toLowerCase();
    const originOwnerBytes32 =
      `0x000000000000000000000000${originOwner.slice(2)}` as const;
    const originRouterBytes32 =
      '0x0000000000000000000000005050505050505050505050505050505050505051';

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
              return probeValue;
            }
          : (chainName: string) => {
              if (chainName === CHAIN) return {};
              originSignerProbeCalls += 1;
              return probeValue;
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

  PROBE_CASES.forEach(
    ({ label, probeValue, expectedOriginSignerAddressLookups }) => {
    it(`caches ${label} origin signer probes across timelock ICA inferences`, async () => {
      const setup = createDirectSetup(probeValue, false);
      try {
        const batches = await resolveSubmitterBatchesForTransactions({
          chain: CHAIN,
          transactions: [
            { ...TX, to: '0x1111111111111111111111111111111111111111' } as any,
            { ...TX, to: '0x4444444444444444444444444444444444444444' } as any,
          ],
          context: setup.context,
        });
        expectTimelockJsonRpcBatches(batches);
        expect(setup.getOriginSignerProbeCalls()).to.be.at.most(1);
        expect(setup.getOriginSignerAddressLookups()).to.be.at.most(
          expectedOriginSignerAddressLookups,
        );
        expect(setup.provider.getLogs.callCount).to.be.greaterThanOrEqual(4);
      } finally {
        setup.restore();
      }
    });

    it(`caches async ${label} origin signer probes across timelock ICA inferences`, async () => {
      const setup = createDirectSetup(probeValue, true);
      try {
        const batches = await resolveSubmitterBatchesForTransactions({
          chain: CHAIN,
          transactions: [
            { ...TX, to: '0x1111111111111111111111111111111111111111' } as any,
            { ...TX, to: '0x4444444444444444444444444444444444444444' } as any,
          ],
          context: setup.context,
        });
        expectTimelockJsonRpcBatches(batches);
        expect(setup.getOriginSignerProbeCalls()).to.be.at.most(1);
        expect(setup.getOriginSignerAddressLookups()).to.be.at.most(
          expectedOriginSignerAddressLookups,
        );
        expect(setup.provider.getLogs.callCount).to.be.greaterThanOrEqual(4);
      } finally {
        setup.restore();
      }
    });

    it(`caches event-derived ${label} origin signer probes across timelock ICA inferences`, async () => {
      const setup = createEventDerivedSetup(probeValue, false);
      try {
        const batches = await resolveSubmitterBatchesForTransactions({
          chain: CHAIN,
          transactions: [
            { ...TX, to: '0x1111111111111111111111111111111111111111' } as any,
            { ...TX, to: '0x4444444444444444444444444444444444444444' } as any,
          ],
          context: setup.context,
        });
        expectTimelockJsonRpcBatches(batches);
        expect(setup.getOriginSignerProbeCalls()).to.be.at.most(1);
        expect(setup.getOriginSignerAddressLookups()).to.be.at.most(
          expectedOriginSignerAddressLookups,
        );
        expect(setup.getChainNameCalls()).to.equal(1);
        expect(setup.provider.getLogs.callCount).to.equal(5);
      } finally {
        setup.restore();
      }
    });

    it(`caches event-derived async ${label} origin signer probes across timelock ICA inferences`, async () => {
      const setup = createEventDerivedSetup(probeValue, true);
      try {
        const batches = await resolveSubmitterBatchesForTransactions({
          chain: CHAIN,
          transactions: [
            { ...TX, to: '0x1111111111111111111111111111111111111111' } as any,
            { ...TX, to: '0x4444444444444444444444444444444444444444' } as any,
          ],
          context: setup.context,
        });
        expectTimelockJsonRpcBatches(batches);
        expect(setup.getOriginSignerProbeCalls()).to.be.at.most(1);
        expect(setup.getOriginSignerAddressLookups()).to.be.at.most(
          expectedOriginSignerAddressLookups,
        );
        expect(setup.getChainNameCalls()).to.equal(1);
        expect(setup.provider.getLogs.callCount).to.equal(5);
      } finally {
        setup.restore();
      }
    });
    },
  );
});
