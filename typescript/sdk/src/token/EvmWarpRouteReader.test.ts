import {
  CrossCollateralRouter__factory,
  EverclearTokenBridge__factory,
  HypERC20Collateral__factory,
  IFiatToken__factory,
  IXERC20__factory,
  PackageVersioned__factory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { ethers } from 'ethers';
import sinon from 'sinon';

import { assert } from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import {
  EIP1967_BEACON_SLOT,
  EIP1967_IMPLEMENTATION_SLOT,
} from '../deploy/proxy.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { EvmEventLogsReader } from '../rpc/evm/EvmEventLogsReader.js';
import { GetEventLogsResponse } from '../rpc/evm/types.js';
import {
  errorStringRevertError,
  ethersCallExceptionWithNestedError,
  lsp17NoExtensionError,
  missingSelectorError,
  networkError,
  panicRevertError,
  unrecognisedCustomRevertError,
} from '../test/errors.js';
import { randomAddress } from '../test/testUtils.js';

import { EvmWarpRouteReader } from './EvmWarpRouteReader.js';
import { TokenType } from './config.js';
import { XERC20Type } from './types.js';
import { CONFIGURATION_CHANGED_EVENT_SELECTOR } from './xerc20-abi.js';

chai.use(chaiAsPromised);

describe('EvmWarpRouteReader', () => {
  let sandbox: sinon.SinonSandbox;
  let multiProvider: MultiProvider;
  let reader: EvmWarpRouteReader;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    multiProvider = MultiProvider.createTestMultiProvider();
    reader = new EvmWarpRouteReader(multiProvider, TestChainName.test1);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('falls back to the legacy package version when PACKAGE_VERSION is missing', async () => {
    sandbox.stub(PackageVersioned__factory, 'connect').returns({
      PACKAGE_VERSION: sandbox.stub().rejects(missingSelectorError()),
    } as any);

    const version = await reader.fetchPackageVersion(randomAddress());

    expect(version).to.equal('5.3.9');
  });

  it('throws transient package version probe failures', async () => {
    const transientError = networkError();
    sandbox.stub(PackageVersioned__factory, 'connect').returns({
      PACKAGE_VERSION: sandbox.stub().rejects(transientError),
    } as any);

    let thrown: unknown;
    try {
      await reader.fetchPackageVersion(randomAddress());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.equal(transientError);
  });

  describe('fetchTokenFee', () => {
    function stubFeeRecipient(feeRecipient: sinon.SinonStub): void {
      sandbox.stub(TokenRouter__factory, 'connect').returns({
        feeRecipient,
      } as unknown as ReturnType<typeof TokenRouter__factory.connect>);
    }

    it('skips feeRecipient for routers without the token fee interface', async () => {
      const feeRecipient = sandbox.stub().rejects(panicRevertError());
      stubFeeRecipient(feeRecipient);
      sandbox.stub(reader, 'fetchPackageVersion').resolves('8.1.2');

      const result = await reader.fetchTokenFee(randomAddress());

      expect(result).to.equal(undefined);
      expect(feeRecipient.called).to.equal(false);
    });

    it('treats an LSP17 no-extension revert from feeRecipient as no token fee', async () => {
      stubFeeRecipient(sandbox.stub().rejects(lsp17NoExtensionError()));
      sandbox.stub(reader, 'fetchPackageVersion').resolves('10.0.0');

      expect(await reader.fetchTokenFee(randomAddress())).to.equal(undefined);
    });

    const failureCases = [
      { name: 'a network error', error: networkError },
      {
        name: 'an unrecognised custom revert',
        error: unrecognisedCustomRevertError,
      },
    ];

    for (const c of failureCases) {
      it(`rejects when feeRecipient fails with ${c.name} on a fee-capable router`, async () => {
        const error = c.error();
        stubFeeRecipient(sandbox.stub().rejects(error));
        sandbox.stub(reader, 'fetchPackageVersion').resolves('10.0.0');

        await expect(reader.fetchTokenFee(randomAddress())).to.be.rejectedWith(
          error.message,
        );
      });
    }
  });

  describe('fetchFeeHook', () => {
    const feeHookSelector = TokenRouter__factory.createInterface()
      .getSighash('feeHook()')
      .slice(2);

    function stubProxyProvider(implBytecode: string): {
      call: sinon.SinonStub;
      getCode: sinon.SinonStub;
    } {
      const provider = multiProvider.getProvider(TestChainName.test1);
      const impl = randomAddress();
      const getCode = sandbox
        .stub(provider, 'getCode')
        .callsFake(async (address) =>
          (await address) === ethers.utils.getAddress(impl)
            ? implBytecode
            : '0x60',
        );
      sandbox
        .stub(provider, 'getStorageAt')
        .callsFake(async (address) =>
          (await address) === ethers.utils.getAddress(impl)
            ? `0x${'00'.repeat(32)}`
            : `0x${'00'.repeat(12)}${impl.slice(2)}`,
        );
      const call = sandbox
        .stub(provider, 'call')
        .rejects(unrecognisedCustomRevertError());
      return { call, getCode };
    }

    it('skips feeHook() when bytecode has no feeHook() selector', async () => {
      const { call } = stubProxyProvider('0x6080604052deadbeef');

      expect(await reader.fetchFeeHook(randomAddress())).to.equal(undefined);
      expect(call.called).to.equal(false);
    });

    it('rejects an unrecognised revert when bytecode has the feeHook() selector', async () => {
      const { call } = stubProxyProvider(`0x6080604052${feeHookSelector}`);

      await expect(reader.fetchFeeHook(randomAddress())).to.be.rejectedWith(
        'call revert exception',
      );
      expect(call.called).to.equal(true);
    });

    it('treats an LSP17 no-extension revert as a missing feeHook() selector', async () => {
      const { call } = stubProxyProvider(`0x6080604052${feeHookSelector}`);
      call.rejects(lsp17NoExtensionError());

      expect(await reader.fetchFeeHook(randomAddress())).to.equal(undefined);
      expect(call.called).to.equal(true);
    });

    it('makes the call when bytecode is empty', async () => {
      const { call } = stubProxyProvider('0x');

      await expect(reader.fetchFeeHook(randomAddress())).to.be.rejectedWith(
        'call revert exception',
      );
      expect(call.called).to.equal(true);
    });

    it('caches implementation bytecode per address', async () => {
      const { getCode } = stubProxyProvider('0x6080604052deadbeef');
      const router = randomAddress();

      await reader.fetchFeeHook(router);
      const callsAfterFirst = getCode.callCount;
      await reader.fetchFeeHook(router.toLowerCase());

      expect(getCode.callCount).to.equal(callsAfterFirst);
    });
  });

  describe('implementation bytecode resolution', () => {
    const feeHookSelector = TokenRouter__factory.createInterface()
      .getSighash('feeHook()')
      .slice(2);
    const ZERO_SLOT = `0x${'00'.repeat(32)}`;
    const WITH_SELECTOR = `0x6080604052${feeHookSelector}`;
    const WITHOUT_SELECTOR = '0x6080604052deadbeef';
    const WITHOUT_SELECTOR_WITH_DELEGATECALL = '0x6080604052f4deadbeef';

    const router = randomAddress();
    const impl = ethers.utils.getAddress(randomAddress());
    const addressSlot = (address: string) =>
      `0x${'00'.repeat(12)}${address.slice(2).toLowerCase()}`;
    const minimalProxyCode = (address: string) =>
      `0x363d3d373d3d3d363d73${address.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;

    interface Case {
      name: string;
      routerCode: string | Error;
      implCode?: string;
      implSlot: string | Error;
      beaconSlot: string | Error;
      expectCall: boolean;
    }

    const cases: Case[] = [
      {
        name: 'reads the EIP-1967 implementation without the selector',
        routerCode: '0x60',
        implCode: WITHOUT_SELECTOR,
        implSlot: addressSlot(impl),
        beaconSlot: ZERO_SLOT,
        expectCall: false,
      },
      {
        name: 'reads the EIP-1967 implementation with the selector',
        routerCode: '0x60',
        implCode: WITH_SELECTOR,
        implSlot: addressSlot(impl),
        beaconSlot: ZERO_SLOT,
        expectCall: true,
      },
      {
        name: 'uses the own code of a non-proxy without the selector',
        routerCode: WITHOUT_SELECTOR,
        implSlot: ZERO_SLOT,
        beaconSlot: ZERO_SLOT,
        expectCall: false,
      },
      {
        name: 'uses the own code of a non-proxy with the selector',
        routerCode: WITH_SELECTOR,
        implSlot: '0x0',
        beaconSlot: '0x',
        expectCall: true,
      },
      {
        name: 'probes an address without code',
        routerCode: '0x',
        implSlot: ZERO_SLOT,
        beaconSlot: ZERO_SLOT,
        expectCall: true,
      },
      {
        name: 'resolves an EIP-1167 minimal proxy without the selector',
        routerCode: minimalProxyCode(impl),
        implCode: WITHOUT_SELECTOR,
        implSlot: ZERO_SLOT,
        beaconSlot: ZERO_SLOT,
        expectCall: false,
      },
      {
        name: 'resolves an EIP-1167 minimal proxy with the selector',
        routerCode: minimalProxyCode(impl),
        implCode: WITH_SELECTOR,
        implSlot: ZERO_SLOT,
        beaconSlot: ZERO_SLOT,
        expectCall: true,
      },
      {
        name: 'probes a DELEGATECALL-containing EIP-1967 implementation without the selector',
        routerCode: '0x60',
        implCode: WITHOUT_SELECTOR_WITH_DELEGATECALL,
        implSlot: addressSlot(impl),
        beaconSlot: ZERO_SLOT,
        expectCall: true,
      },
      {
        name: 'probes a DELEGATECALL-containing EIP-1167 target without the selector',
        routerCode: minimalProxyCode(impl),
        implCode: WITHOUT_SELECTOR_WITH_DELEGATECALL,
        implSlot: ZERO_SLOT,
        beaconSlot: ZERO_SLOT,
        expectCall: true,
      },
      {
        name: 'probes the own forwarding code of a non-proxy without the selector',
        routerCode: WITHOUT_SELECTOR_WITH_DELEGATECALL,
        implSlot: ZERO_SLOT,
        beaconSlot: ZERO_SLOT,
        expectCall: true,
      },
      {
        name: 'probes a beacon proxy',
        routerCode: WITHOUT_SELECTOR,
        implSlot: ZERO_SLOT,
        beaconSlot: addressSlot(impl),
        expectCall: true,
      },
      {
        name: 'probes when the implementation slot read fails',
        routerCode: WITHOUT_SELECTOR,
        implSlot: new Error('rpc unavailable'),
        beaconSlot: ZERO_SLOT,
        expectCall: true,
      },
      {
        name: 'probes when the beacon slot read fails',
        routerCode: WITHOUT_SELECTOR,
        implSlot: ZERO_SLOT,
        beaconSlot: new Error('rpc unavailable'),
        expectCall: true,
      },
      {
        name: 'probes when reading the own code fails',
        routerCode: new Error('rpc unavailable'),
        implSlot: ZERO_SLOT,
        beaconSlot: ZERO_SLOT,
        expectCall: true,
      },
      {
        name: 'probes when reading the implementation code fails',
        routerCode: '0x60',
        implCode: undefined,
        implSlot: addressSlot(impl),
        beaconSlot: ZERO_SLOT,
        expectCall: true,
      },
    ];

    function stubProvider(c: Case): {
      call: sinon.SinonStub;
      getCode: sinon.SinonStub;
    } {
      const provider = multiProvider.getProvider(TestChainName.test1);
      const getCode = sandbox
        .stub(provider, 'getCode')
        .callsFake(async (address) => {
          const resolved = await address;
          const code =
            resolved.toLowerCase() === router.toLowerCase()
              ? c.routerCode
              : c.implCode;
          if (code === undefined) throw new Error('rpc unavailable');
          if (code instanceof Error) throw code;
          return code;
        });
      sandbox
        .stub(provider, 'getStorageAt')
        .callsFake(async (address, slot) => {
          if ((await address).toLowerCase() !== router.toLowerCase()) {
            return ZERO_SLOT;
          }
          const value =
            slot === EIP1967_BEACON_SLOT ? c.beaconSlot : c.implSlot;
          if (value instanceof Error) throw value;
          return value;
        });
      const call = sandbox
        .stub(provider, 'call')
        .rejects(unrecognisedCustomRevertError());
      return { call, getCode };
    }

    for (const c of cases) {
      it(c.name, async () => {
        const { call } = stubProvider(c);

        if (c.expectCall) {
          await expect(reader.fetchFeeHook(router)).to.be.rejectedWith(
            'call revert exception',
          );
        } else {
          expect(await reader.fetchFeeHook(router)).to.equal(undefined);
        }
        expect(call.called).to.equal(c.expectCall);
      });
    }

    it('does not cache unknown bytecode', async () => {
      const c = cases.find((x) => x.name.includes('implementation slot read'));
      assert(c, 'case exists');
      const { getCode } = stubProvider(c);

      await expect(reader.fetchFeeHook(router)).to.be.rejectedWith(
        'call revert exception',
      );
      const callsAfterFirst = getCode.callCount;
      await expect(reader.fetchFeeHook(router)).to.be.rejectedWith(
        'call revert exception',
      );

      expect(getCode.callCount).to.be.greaterThan(callsAfterFirst);
    });

    it('shares one bytecode read between deriveTokenType and the getters', async () => {
      const { getCode } = stubProvider(cases[2]);

      await reader.deriveTokenType(router).catch(() => undefined);
      const callsAfterDerive = getCode.callCount;
      await reader.fetchFeeHook(router);

      expect(getCode.callCount).to.equal(callsAfterDerive);
    });
  });

  describe('fetchScale', () => {
    const scaleSelector = new ethers.utils.Interface([
      'function scale() view returns (uint256)',
    ])
      .getSighash('scale()')
      .slice(2);

    interface Case {
      name: string;
      bytecode: string;
      expectCall: boolean;
    }

    const cases: Case[] = [
      {
        name: 'skips scale() when bytecode has no scale() selector',
        bytecode: '0x6080604052deadbeef',
        expectCall: false,
      },
      {
        name: 'calls scale() when bytecode is empty',
        bytecode: '0x',
        expectCall: true,
      },
    ];

    function stubProxyProvider(implBytecode: string): sinon.SinonStub {
      const provider = multiProvider.getProvider(TestChainName.test1);
      const impl = randomAddress();
      sandbox
        .stub(provider, 'getCode')
        .callsFake(async (address) =>
          (await address) === ethers.utils.getAddress(impl)
            ? implBytecode
            : '0x60',
        );
      sandbox
        .stub(provider, 'getStorageAt')
        .callsFake(async (address) =>
          (await address) === ethers.utils.getAddress(impl)
            ? `0x${'00'.repeat(32)}`
            : `0x${'00'.repeat(12)}${impl.slice(2)}`,
        );
      sandbox.stub(reader, 'fetchPackageVersion').resolves('8.0.0');
      return sandbox
        .stub(provider, 'call')
        .rejects(new Error('Invalid response from provider'));
    }

    for (const c of cases) {
      it(c.name, async () => {
        const router = randomAddress();
        const call = stubProxyProvider(c.bytecode);

        expect(await reader.fetchScale(router)).to.equal(undefined);
        expect(call.called).to.equal(c.expectCall);
      });
    }

    it('treats an empty provider response as identity when a DELEGATECALL-bearing bytecode lacks the scale() selector', async () => {
      const router = randomAddress();
      const call = stubProxyProvider('0x6080604052f4deadbeef');

      expect(await reader.fetchScale(router)).to.equal(undefined);
      expect(call.called).to.equal(true);
    });

    it('rejects an empty provider response when the bytecode has the scale() selector', async () => {
      const router = randomAddress();
      const call = stubProxyProvider(`0x6080604052${scaleSelector}`);

      await expect(reader.fetchScale(router)).to.be.rejectedWith(
        'Invalid response from provider',
      );
      expect(call.called).to.equal(true);
    });
  });

  describe('fetchScale legacy scale() reverts', () => {
    const scaleSelector = new ethers.utils.Interface([
      'function scale() view returns (uint256)',
    ])
      .getSighash('scale()')
      .slice(2);

    const SELECTOR_AND_NO_DELEGATECALL = `0x6080604052${scaleSelector}`;
    const SELECTOR_AND_DELEGATECALL = `0x6080604052f4${scaleSelector}`;
    const NO_SELECTOR_AND_DELEGATECALL = '0x6080604052f4deadbeef';

    function stubScaleCall(
      error: Error,
      bytecode = SELECTOR_AND_DELEGATECALL,
    ): void {
      const provider = multiProvider.getProvider(TestChainName.test1);
      const impl = randomAddress();
      sandbox
        .stub(provider, 'getCode')
        .callsFake(async (address) =>
          (await address) === ethers.utils.getAddress(impl) ? bytecode : '0x60',
        );
      sandbox
        .stub(provider, 'getStorageAt')
        .callsFake(async (address) =>
          (await address) === ethers.utils.getAddress(impl)
            ? `0x${'00'.repeat(32)}`
            : `0x${'00'.repeat(12)}${impl.slice(2)}`,
        );
      sandbox.stub(reader, 'fetchPackageVersion').resolves('8.0.0');
      sandbox.stub(provider, 'call').rejects(error);
    }

    it('treats an execution reverted scale() call without data as identity', async () => {
      stubScaleCall(
        ethersCallExceptionWithNestedError({
          code: 3,
          message: 'execution reverted',
        }),
      );

      expect(await reader.fetchScale(randomAddress())).to.equal(undefined);
    });

    it('treats a code 3 revert as identity when the bytecode has the selector and no DELEGATECALL', async () => {
      stubScaleCall(
        ethersCallExceptionWithNestedError({
          code: 3,
          message: 'execution reverted',
        }),
        SELECTOR_AND_NO_DELEGATECALL,
      );

      expect(await reader.fetchScale(randomAddress())).to.equal(undefined);
    });

    it('rejects a transport error from the scale() call of a forwarding implementation', async () => {
      const error = ethersCallExceptionWithNestedError(
        Object.assign(new Error('Too Many Requests'), {
          code: 'SERVER_ERROR',
          status: 429,
          data: '0x',
        }),
      );
      stubScaleCall(error, NO_SELECTOR_AND_DELEGATECALL);

      await expect(reader.fetchScale(randomAddress())).to.be.rejectedWith(
        error.message,
      );
    });

    it('rejects a transport error from the scale() call', async () => {
      const error = ethersCallExceptionWithNestedError(
        Object.assign(new Error('Too Many Requests'), {
          code: 'SERVER_ERROR',
          status: 429,
          data: '0x',
        }),
      );
      stubScaleCall(error);

      await expect(reader.fetchScale(randomAddress())).to.be.rejectedWith(
        error.message,
      );
    });
  });

  describe('forwarding implementations without the selector', () => {
    const iface = new ethers.utils.Interface([
      'function scale() view returns (uint256)',
      'function feeHook() view returns (address)',
    ]);
    const FORWARDING_CODE = '0x6080604052f4deadbeef';
    const feeHookAddress = ethers.utils.getAddress(randomAddress());
    const scale = 10n ** 12n;

    type ProxyKind = 'EIP-1967' | 'EIP-1167';

    function stubForwarder(kind: ProxyKind): {
      call: sinon.SinonStub;
      router: string;
    } {
      const provider = multiProvider.getProvider(TestChainName.test1);
      const impl = ethers.utils.getAddress(randomAddress());
      const router = ethers.utils.getAddress(randomAddress());
      const routerCode =
        kind === 'EIP-1167'
          ? `0x363d3d373d3d3d363d73${impl.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`
          : '0x60';
      sandbox
        .stub(provider, 'getCode')
        .callsFake(async (address) =>
          (await address) === impl ? FORWARDING_CODE : routerCode,
        );
      sandbox
        .stub(provider, 'getStorageAt')
        .callsFake(async (address) =>
          kind === 'EIP-1967' && (await address) === router
            ? `0x${'00'.repeat(12)}${impl.slice(2).toLowerCase()}`
            : `0x${'00'.repeat(32)}`,
        );
      sandbox.stub(reader, 'fetchPackageVersion').resolves('8.0.0');
      return { call: sandbox.stub(provider, 'call'), router };
    }

    const kinds: ProxyKind[] = ['EIP-1967', 'EIP-1167'];
    const reverts = [
      {
        name: 'a code 3 revert with empty data',
        error: () =>
          ethersCallExceptionWithNestedError({
            code: 3,
            message: 'execution reverted',
            data: '0x',
          }),
      },
      { name: 'an LSP17 no-extension revert', error: lsp17NoExtensionError },
    ];

    for (const kind of kinds) {
      it(`returns the feeHook() value of an ${kind} target`, async () => {
        const { call, router } = stubForwarder(kind);
        call.resolves(iface.encodeFunctionResult('feeHook', [feeHookAddress]));

        expect(await reader.fetchFeeHook(router)).to.equal(feeHookAddress);
        expect(call.called).to.equal(true);
      });

      it(`returns the scale() value of an ${kind} target`, async () => {
        const { call, router } = stubForwarder(kind);
        call.resolves(iface.encodeFunctionResult('scale', [scale]));

        expect(await reader.fetchScale(router)).to.deep.equal({
          numerator: scale,
          denominator: 1n,
        });
        expect(call.called).to.equal(true);
      });

      for (const revert of reverts) {
        it(`tolerates ${revert.name} from feeHook() of an ${kind} target`, async () => {
          const { call, router } = stubForwarder(kind);
          call.rejects(revert.error());

          expect(await reader.fetchFeeHook(router)).to.equal(undefined);
          expect(call.called).to.equal(true);
        });

        it(`tolerates ${revert.name} from scale() of an ${kind} target`, async () => {
          const { call, router } = stubForwarder(kind);
          call.rejects(revert.error());

          expect(await reader.fetchScale(router)).to.equal(undefined);
          expect(call.called).to.equal(true);
        });
      }
    }
  });

  describe('deriveTokenType xERC20 probe', () => {
    async function deriveWithXERC20Probe(
      probeError?: Error,
      wrappedTokenCode?: string,
    ): Promise<TokenType> {
      const wrappedTokenSelector = HypERC20Collateral__factory.createInterface()
        .getSighash('wrappedToken')
        .slice(2);
      const xerc20Selector = IXERC20__factory.createInterface()
        .getSighash('mintingCurrentLimitOf(address)')
        .slice(2);
      const wrappedToken = randomAddress();
      const provider = multiProvider.getProvider(TestChainName.test1);
      sandbox
        .stub(provider, 'getCode')
        .callsFake(async (address) =>
          (await address).toLowerCase() === wrappedToken.toLowerCase()
            ? (wrappedTokenCode ?? `0x${xerc20Selector}`)
            : `0x${wrappedTokenSelector}`,
        );
      sandbox.stub(provider, 'getStorageAt').resolves(`0x${'00'.repeat(32)}`);
      sandbox.stub(HypERC20Collateral__factory, 'connect').returns({
        wrappedToken: sandbox.stub().resolves(wrappedToken),
      } as unknown as ReturnType<typeof HypERC20Collateral__factory.connect>);
      const probe = sandbox.stub();
      if (probeError) probe.rejects(probeError);
      else probe.resolves(42);
      sandbox.stub(IXERC20__factory, 'connect').returns({
        'mintingCurrentLimitOf(address)': probe,
      } as unknown as ReturnType<typeof IXERC20__factory.connect>);
      sandbox.stub(IFiatToken__factory, 'connect').returns({
        callStatic: { mint: sandbox.stub().rejects(missingSelectorError()) },
      } as unknown as ReturnType<typeof IFiatToken__factory.connect>);
      sandbox.stub(EverclearTokenBridge__factory, 'connect').returns({
        callStatic: {
          everclearAdapter: sandbox.stub().rejects(missingSelectorError()),
        },
      } as unknown as ReturnType<typeof EverclearTokenBridge__factory.connect>);
      sandbox.stub(CrossCollateralRouter__factory, 'connect').returns({
        getCrossCollateralRouters: sandbox
          .stub()
          .rejects(missingSelectorError()),
      } as unknown as ReturnType<
        typeof CrossCollateralRouter__factory.connect
      >);

      return reader.deriveTokenType(randomAddress());
    }

    it('skips the probe when a legacy wrapped token lacks the xERC20 selector', async () => {
      const invalidOpcodeError = Object.assign(
        new Error('missing revert data in call exception'),
        {
          code: 'CALL_EXCEPTION',
          data: '0x',
          error: { code: -32003, message: 'EVM error: InvalidFEOpcode' },
        },
      );

      expect(
        await deriveWithXERC20Probe(invalidOpcodeError, '0x6080604052deadbeef'),
      ).to.equal(TokenType.collateral);
    });

    it('probes an xERC20 behind an unresolved PUSH0 clone', async () => {
      const implementation = randomAddress().slice(2).toLowerCase();
      const push0Clone = `0x5f5f365f5f37365f73${implementation}5af43d5f5f3e6029573d5ffd5b3d5ff3`;

      expect(await deriveWithXERC20Probe(undefined, push0Clone)).to.equal(
        TokenType.XERC20,
      );
    });

    const fallThroughCases = [
      { name: 'a panic revert', error: panicRevertError },
      { name: 'a missing selector', error: missingSelectorError },
      { name: 'an LSP17 no-extension revert', error: lsp17NoExtensionError },
    ];

    for (const c of fallThroughCases) {
      it(`treats ${c.name} as not xERC20`, async () => {
        expect(await deriveWithXERC20Probe(c.error())).to.equal(
          TokenType.collateral,
        );
      });
    }

    const surfacedCases = [
      { name: 'an Error(string) revert', error: errorStringRevertError },
      {
        name: 'an unrecognised custom revert',
        error: unrecognisedCustomRevertError,
      },
    ];

    for (const c of surfacedCases) {
      it(`rethrows ${c.name} from the xERC20 probe`, async () => {
        const error = c.error();
        let thrown: unknown;
        try {
          await deriveWithXERC20Probe(error);
        } catch (e) {
          thrown = e;
        }
        expect(thrown).to.equal(error);
      });
    }

    it('rethrows transient xERC20 probe failures', async () => {
      const error = networkError();
      let thrown: unknown;
      try {
        await deriveWithXERC20Probe(error);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).to.equal(error);
    });
  });

  describe('fetchXERC20Config', () => {
    // A mainnet router, one of the bridges its token holds limits for, and
    // that token. Real addresses so the checksummed casing below is the casing
    // a deploy config carries.
    const WARP_ROUTER = '0x88AC0fC430130983c0DDEB4C22574056D8340Ca8';
    const EXTRA_BRIDGE = '0x6D265C7dD8d76F25155F1a7687C693FDC1220D12';
    const XERC20_ADDRESS = '0x1217BfE6c773EEC6cc4A38b5Dc45B92292B6E189';
    const IMPLEMENTATION = '0xf24508eC5f0208589be2B206173993fBd7D6506d';

    const setBufferCapSelector = ethers.utils
      .id('setBufferCap(address,uint256)')
      .slice(2, 10);
    const setLimitsSelector = ethers.utils
      .id('setLimits(address,uint256,uint256)')
      .slice(2, 10);
    const rateLimitsSelector = ethers.utils
      .id('rateLimits(address)')
      .slice(0, 10);
    const mintingMaxLimitOfSelector = ethers.utils
      .id('mintingMaxLimitOf(address)')
      .slice(0, 10);
    const burningMaxLimitOfSelector = ethers.utils
      .id('burningMaxLimitOf(address)')
      .slice(0, 10);

    // The scan resolves the token's deployment block before it reads, which
    // would otherwise be a live block explorer request.
    beforeEach(() => {
      sandbox
        .stub(EvmEventLogsReader.prototype, 'getContractDeploymentBlock')
        .resolves(1);
    });

    function bridgeAnnouncement(bridge: string): GetEventLogsResponse {
      return {
        address: XERC20_ADDRESS,
        blockNumber: 10,
        data: ethers.utils.defaultAbiCoder.encode(
          ['uint112', 'uint128'],
          [1, 1],
        ),
        logIndex: 0,
        topics: [
          CONFIGURATION_CHANGED_EVENT_SELECTOR,
          ethers.utils.hexZeroPad(bridge, 32),
        ],
        transactionHash: ethers.utils.hexZeroPad('0x10', 32),
        transactionIndex: 0,
      };
    }

    function stubToken(
      type: XERC20Type,
      limits: Record<string, [string, string]>,
    ): sinon.SinonStub {
      const provider = multiProvider.getProvider(TestChainName.test1);
      const getCode = sandbox
        .stub(provider, 'getCode')
        .resolves(
          `0x${type === XERC20Type.Velo ? setBufferCapSelector : setLimitsSelector}`,
        );
      sandbox.stub(provider, 'call').callsFake(async (transaction) => {
        const data = await transaction.data;
        assert(typeof data === 'string', 'Expected call data');
        const selector = data.slice(0, 10);
        const [bridge] = ethers.utils.defaultAbiCoder.decode(
          ['address'],
          `0x${data.slice(10)}`,
        );
        const entry = limits[bridge.toLowerCase()];
        assert(entry, `Unexpected limits read for ${bridge}`);

        if (selector === rateLimitsSelector) {
          return ethers.utils.defaultAbiCoder.encode(
            ['tuple(uint128,uint112,uint32,uint112,uint112)'],
            [[entry[1], entry[0], 0, 0, 0]],
          );
        }
        if (selector === mintingMaxLimitOfSelector) {
          return ethers.utils.defaultAbiCoder.encode(['uint256'], [entry[0]]);
        }
        if (selector === burningMaxLimitOfSelector) {
          return ethers.utils.defaultAbiCoder.encode(['uint256'], [entry[1]]);
        }
        throw new Error(`Unexpected call ${selector}`);
      });

      return getCode;
    }

    // A Standard xERC20 exposes no bufferCap getter, so reading it as a
    // Velodrome token dropped the whole xERC20 block from the derived config.
    it('derives the limits of a Standard xERC20', async () => {
      sandbox.stub(EvmEventLogsReader.prototype, 'getLogsByTopic').resolves([]);
      const getCode = stubToken(XERC20Type.Standard, {
        [WARP_ROUTER.toLowerCase()]: ['20000000000000', '20000000000000'],
      });

      const config = await reader.fetchXERC20Config(
        XERC20_ADDRESS,
        WARP_ROUTER,
      );

      expect(config).to.deep.equal({
        xERC20: {
          warpRouteLimits: {
            type: XERC20Type.Standard,
            mint: '20000000000000',
            burn: '20000000000000',
          },
          extraBridges: undefined,
        },
      });
      expect(getCode.calledOnce).to.be.true;
    });

    it('derives the limits of a Velodrome xERC20', async () => {
      sandbox.stub(EvmEventLogsReader.prototype, 'getLogsByTopic').resolves([]);
      stubToken(XERC20Type.Velo, {
        [WARP_ROUTER.toLowerCase()]: ['2000000000000', '500000000'],
      });

      const config = await reader.fetchXERC20Config(
        XERC20_ADDRESS,
        WARP_ROUTER,
      );

      expect(config).to.deep.equal({
        xERC20: {
          warpRouteLimits: {
            type: XERC20Type.Velo,
            bufferCap: '2000000000000',
            rateLimitPerSecond: '500000000',
          },
          extraBridges: undefined,
        },
      });
    });

    // The route's own router holds bridge limits like any other bridge and the
    // token announces it alongside the rest. They are reported as
    // warpRouteLimits, so repeating them as an extra bridge would double count
    // the route against itself.
    it('never reports the warp route router as an extra bridge', async () => {
      sandbox
        .stub(EvmEventLogsReader.prototype, 'getLogsByTopic')
        .resolves([
          bridgeAnnouncement(WARP_ROUTER),
          bridgeAnnouncement(EXTRA_BRIDGE),
        ]);
      stubToken(XERC20Type.Velo, {
        [WARP_ROUTER.toLowerCase()]: ['2000000000000', '500000000'],
        [EXTRA_BRIDGE.toLowerCase()]: ['20000000000000', '5000000000'],
      });

      const config = await reader.fetchXERC20Config(
        XERC20_ADDRESS,
        WARP_ROUTER,
      );

      // Checksummed because the reader normalizes every bridge address it
      // reports, which is what the diff against the deploy config compares.
      expect(config.xERC20?.extraBridges).to.deep.equal([
        {
          lockbox: '0x6D265C7dD8d76F25155F1a7687C693FDC1220D12',
          limits: {
            type: XERC20Type.Velo,
            bufferCap: '20000000000000',
            rateLimitPerSecond: '5000000000',
          },
        },
      ]);
    });

    // A UUPS proxy holds its upgrade logic in the implementation and leaves the
    // admin slot empty, so a derivation keyed on an admin never reads the
    // bytecode that carries the selectors and reports the token as having no
    // limits interface, which the caller turns into an empty config and the
    // check reads as nothing to verify.
    it('derives the limits of a token behind a UUPS proxy', async () => {
      sandbox.stub(EvmEventLogsReader.prototype, 'getLogsByTopic').resolves([]);
      const getCode = stubToken(XERC20Type.Standard, {
        [WARP_ROUTER.toLowerCase()]: ['20000000000000', '20000000000000'],
      });
      // The proxy delegates, so its own bytecode carries neither selector.
      getCode.withArgs(XERC20_ADDRESS).resolves('0xdead');
      getCode.withArgs(IMPLEMENTATION).resolves(`0x${setLimitsSelector}`);

      const provider = multiProvider.getProvider(TestChainName.test1);
      sandbox
        .stub(provider, 'getStorageAt')
        .callsFake(async (address, position) => {
          if ((await address) === IMPLEMENTATION) {
            return ethers.utils.hexZeroPad('0x00', 32);
          }
          const slot = await position;
          assert(
            slot === EIP1967_IMPLEMENTATION_SLOT,
            `Read storage slot ${slot}, which a UUPS proxy does not populate`,
          );
          return ethers.utils.hexZeroPad(IMPLEMENTATION, 32);
        });

      const config = await reader.fetchXERC20Config(
        XERC20_ADDRESS,
        WARP_ROUTER,
      );

      expect(config).to.deep.equal({
        xERC20: {
          warpRouteLimits: {
            type: XERC20Type.Standard,
            mint: '20000000000000',
            burn: '20000000000000',
          },
          extraBridges: undefined,
        },
      });
    });

    // A third-party token implementing neither limit interface is not drift and
    // not a failure: the reader has nothing to say about its limits, and making
    // that fatal would take down the whole check for the route it belongs to.
    it('reports no xERC20 config for a token implementing neither interface', async () => {
      const provider = multiProvider.getProvider(TestChainName.test1);
      sandbox.stub(provider, 'getCode').resolves('0xbeef');
      sandbox
        .stub(provider, 'getStorageAt')
        .resolves(ethers.utils.hexZeroPad('0x00', 32));

      const config = await reader.fetchXERC20Config(
        XERC20_ADDRESS,
        WARP_ROUTER,
      );

      expect(config).to.deep.equal({});
    });

    // A token whose type is detectable but whose limit getter is not there has
    // answered: it holds no limits this SDK can read.
    it('reports no xERC20 config when the limit getter is missing', async () => {
      sandbox.stub(EvmEventLogsReader.prototype, 'getLogsByTopic').resolves([]);
      const provider = multiProvider.getProvider(TestChainName.test1);
      sandbox.stub(provider, 'getCode').resolves(`0x${setBufferCapSelector}`);
      sandbox.stub(provider, 'call').rejects(
        Object.assign(new Error('call revert exception'), {
          code: 'CALL_EXCEPTION',
          data: '0x',
        }),
      );

      const config = await reader.fetchXERC20Config(
        XERC20_ADDRESS,
        WARP_ROUTER,
      );

      expect(config).to.deep.equal({});
    });

    // A provider answering an empty response is not a contract answering that
    // it has no bridges. Reporting one as the other reported a route whose
    // bridges are all configured as having none.
    it('propagates a transient failure instead of reporting no extra bridges', async () => {
      const transientError = new Error('Invalid response from provider');
      sandbox
        .stub(EvmEventLogsReader.prototype, 'getLogsByTopic')
        .rejects(transientError);
      stubToken(XERC20Type.Velo, {
        [WARP_ROUTER.toLowerCase()]: ['2000000000000', '500000000'],
      });

      await expect(
        reader.fetchXERC20Config(XERC20_ADDRESS, WARP_ROUTER),
      ).to.be.rejectedWith('Invalid response from provider');
    });
  });
});
