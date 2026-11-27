import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { ethers } from 'ethers';
import sinon from 'sinon';

import { assert, ensure0x, strip0x } from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import { EIP1967_IMPLEMENTATION_SLOT } from '../deploy/proxy.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { EvmEventLogsReader } from '../rpc/evm/EvmEventLogsReader.js';
import { GetEventLogsResponse } from '../rpc/evm/types.js';
import { viemLogFromGetEventLogsResponse } from '../rpc/evm/utils.js';
import {
  AEVO_ABSENT_SELECTORS,
  AEVO_OWNER_SELECTORS,
  AEVO_SELECTORS,
  AEVO_USDC_IMPLEMENTATION,
  AEVO_USDC_PROXY,
  AEVO_WETH_IMPLEMENTATION,
  aevoTokenCode,
  aevoUsdcImplementationSlotValue,
} from '../test/aevoTokenFixture.js';

import { TokenStandard } from './TokenStandard.js';
import { XERC20TokenExtraBridgesLimits, XERC20Type } from './types.js';
import {
  AEVO_OUTSTANDING_SELECTOR,
  AEVO_XERC20_SELECTORS,
  BRIDGE_LIMITS_SET_EVENT_SELECTOR,
  CONFIGURATION_CHANGED_EVENT_SELECTOR,
  XERC20_AEVO_ABI,
} from './xerc20-abi.js';
import {
  UnknownXERC20TypeError,
  deriveEvmXERC20Standard,
  deriveXERC20TokenType,
  getExtraLockBoxConfigs,
  latestConfigurationPerBridge,
} from './xerc20.js';

chai.use(chaiAsPromised);

const PROXY_ADDRESS = '0x1111111111111111111111111111111111111111';
const IMPLEMENTATION_ADDRESS = '0x2222222222222222222222222222222222222222';

const setBufferCapSelector = ethers.utils
  .id('setBufferCap(address,uint256)')
  .slice(2, 10)
  .toLowerCase();
const setLimitsSelector = ethers.utils
  .id('setLimits(address,uint256,uint256)')
  .slice(2, 10)
  .toLowerCase();

function storageAddress(address: string): string {
  return ethers.utils.hexZeroPad(address, 32);
}

// A token that carries the four selectors that identify an Aevo token, with
// and without the getter of what a minter has minted.
const aevoSelectorsCode = AEVO_XERC20_SELECTORS.map(strip0x).join('');
const aevoCodeWithoutOutstanding = ensure0x(aevoSelectorsCode);
const aevoCodeWithOutstanding = ensure0x(
  `${aevoSelectorsCode}${strip0x(AEVO_OUTSTANDING_SELECTOR)}`,
);

// A node that is not reachable for a call is no answer to whether the token has
// the getter, unlike a call that reverts without data.
const TRANSPORT_FAILURE = Object.assign(new Error('429 Too Many Requests'), {
  code: 'SERVER_ERROR',
  status: 429,
});

interface Case {
  name: string;
  // The token the type is derived for, the proxy at PROXY_ADDRESS unless set.
  address?: string;
  // Bytecode returned by provider.getCode() keyed by address.
  code: Record<string, string>;
  // Storage values returned by provider.getStorageAt() keyed by slot. When a
  // slot is omitted the stub throws, proving the derivation never reads it.
  storage: Record<string, string>;
  expected: { type: XERC20Type } | { errorIncludes: string };
  // What the token answers to the call of its outstanding getter, which only
  // the derivation of the standard of an Aevo token makes. When it is omitted
  // the stub throws, proving no such call is made.
  outstanding?: 'answers' | 'reverts' | 'fails';
  // Set when the type is derived but the standard of the token is not.
  standardErrorIncludes?: string;
}

const NO_GETTER_ERROR = (token: string) =>
  `Unable to derive the standard of ${token}. It carries the Aevo XERC20 limit selectors but not the outstanding getter 0x963aee20`;

const cases: Case[] = [
  {
    // The address bytecode already carries the Velodrome selector, so the
    // proxy path must never be consulted. Reading the admin slot would throw.
    name: 'returns Velo from the address bytecode without inspecting the proxy',
    code: { [PROXY_ADDRESS]: `0x${setBufferCapSelector}` },
    storage: {},
    expected: { type: XERC20Type.Velo },
  },
  {
    // The address bytecode carries the Standard selector; short-circuits too.
    name: 'returns Standard from the address bytecode without inspecting the proxy',
    code: { [PROXY_ADDRESS]: `0x${setLimitsSelector}` },
    storage: {},
    expected: { type: XERC20Type.Standard },
  },
  {
    // Proxy bytecode is a delegatecall stub lacking the selectors; the
    // implementation bytecode carries the Velodrome selector. The admin slot is
    // left out so the stub throws if the derivation reads one.
    name: 'inspects the implementation bytecode when the Velo token is behind a proxy',
    code: {
      [PROXY_ADDRESS]: '0xdead',
      [IMPLEMENTATION_ADDRESS]: `0x${setBufferCapSelector}`,
    },
    storage: {
      [EIP1967_IMPLEMENTATION_SLOT]: storageAddress(IMPLEMENTATION_ADDRESS),
    },
    expected: { type: XERC20Type.Velo },
  },
  {
    // Same proxy path but the implementation carries the Standard selector.
    name: 'inspects the implementation bytecode when the Standard token is behind a proxy',
    code: {
      [PROXY_ADDRESS]: '0xdead',
      [IMPLEMENTATION_ADDRESS]: `0x${setLimitsSelector}`,
    },
    storage: {
      [EIP1967_IMPLEMENTATION_SLOT]: storageAddress(IMPLEMENTATION_ADDRESS),
    },
    expected: { type: XERC20Type.Standard },
  },
  {
    // A UUPS proxy keeps its upgrade logic in the implementation, so its admin
    // slot is empty. Reading the implementation off an admin would skip the
    // only bytecode carrying the selectors; omitting the admin slot here makes
    // the stub throw if it is consulted.
    name: 'inspects the implementation bytecode of a Velo token behind a UUPS proxy',
    code: {
      [PROXY_ADDRESS]: '0xdead',
      [IMPLEMENTATION_ADDRESS]: `0x${setBufferCapSelector}`,
    },
    storage: {
      [EIP1967_IMPLEMENTATION_SLOT]: storageAddress(IMPLEMENTATION_ADDRESS),
    },
    expected: { type: XERC20Type.Velo },
  },
  {
    name: 'inspects the implementation bytecode of a Standard token behind a UUPS proxy',
    code: {
      [PROXY_ADDRESS]: '0xdead',
      [IMPLEMENTATION_ADDRESS]: `0x${setLimitsSelector}`,
    },
    storage: {
      [EIP1967_IMPLEMENTATION_SLOT]: storageAddress(IMPLEMENTATION_ADDRESS),
    },
    expected: { type: XERC20Type.Standard },
  },
  {
    // The recorded Aevo USDC proxy holds none of the selectors itself, so the
    // type can only come from the implementation its slot points to.
    name: 'returns Aevo for the real USDC proxy through its implementation',
    address: AEVO_USDC_PROXY,
    code: {
      [AEVO_USDC_PROXY]: aevoTokenCode(AEVO_USDC_PROXY),
      [AEVO_USDC_IMPLEMENTATION]: aevoTokenCode(AEVO_USDC_IMPLEMENTATION),
    },
    storage: {
      [EIP1967_IMPLEMENTATION_SLOT]: aevoUsdcImplementationSlotValue(),
    },
    outstanding: 'answers',
    expected: { type: XERC20Type.Aevo },
  },
  {
    // The implementation carries every Aevo selector, so the proxy path must
    // never be consulted.
    name: 'returns Aevo for the real WETH implementation without inspecting a proxy',
    address: AEVO_WETH_IMPLEMENTATION,
    code: {
      [AEVO_WETH_IMPLEMENTATION]: aevoTokenCode(AEVO_WETH_IMPLEMENTATION),
    },
    storage: {},
    outstanding: 'answers',
    expected: { type: XERC20Type.Aevo },
  },
  {
    name: 'prefers Standard over Aevo when both selector sets are present',
    code: {
      [PROXY_ADDRESS]: `${aevoTokenCode(AEVO_USDC_IMPLEMENTATION)}${setLimitsSelector}`,
    },
    storage: {},
    expected: { type: XERC20Type.Standard },
  },
  {
    name: 'prefers Velo over Aevo when both selector sets are present',
    code: {
      [PROXY_ADDRESS]: `${aevoTokenCode(AEVO_USDC_IMPLEMENTATION)}${setBufferCapSelector}`,
    },
    storage: {},
    expected: { type: XERC20Type.Velo },
  },
  {
    name: 'returns Aevo for a token whose getter answers',
    code: { [PROXY_ADDRESS]: aevoCodeWithOutstanding },
    storage: {},
    outstanding: 'answers',
    expected: { type: XERC20Type.Aevo },
  },
  {
    // The four selectors identify the type, as they always did, and only the
    // standard needs the getter the Aevo adapter reads its limits with.
    name: 'returns Aevo for a token without the outstanding getter, which has no Aevo standard',
    code: { [PROXY_ADDRESS]: aevoCodeWithoutOutstanding },
    storage: {},
    outstanding: 'reverts',
    expected: { type: XERC20Type.Aevo },
    standardErrorIncludes: NO_GETTER_ERROR(PROXY_ADDRESS),
  },
  {
    // The bytecode of the proxy carries the management selectors, so the
    // implementation is never inspected, and the getter is in the
    // implementation: whether the token has it is what the token answers.
    name: 'returns Aevo for a proxy that carries the management selectors itself and whose getter answers',
    code: { [PROXY_ADDRESS]: aevoCodeWithoutOutstanding },
    storage: {},
    outstanding: 'answers',
    expected: { type: XERC20Type.Aevo },
  },
  {
    name: 'returns Aevo for a proxy whose implementation holds the getter',
    code: {
      [PROXY_ADDRESS]: '0xdead',
      [IMPLEMENTATION_ADDRESS]: aevoCodeWithOutstanding,
    },
    storage: {
      [EIP1967_IMPLEMENTATION_SLOT]: storageAddress(IMPLEMENTATION_ADDRESS),
    },
    outstanding: 'answers',
    expected: { type: XERC20Type.Aevo },
  },
  {
    name: 'returns Aevo for a proxy whose implementation lacks the outstanding getter, which has no Aevo standard',
    code: {
      [PROXY_ADDRESS]: '0xdead',
      [IMPLEMENTATION_ADDRESS]: aevoCodeWithoutOutstanding,
    },
    storage: {
      [EIP1967_IMPLEMENTATION_SLOT]: storageAddress(IMPLEMENTATION_ADDRESS),
    },
    outstanding: 'reverts',
    expected: { type: XERC20Type.Aevo },
    standardErrorIncludes: NO_GETTER_ERROR(PROXY_ADDRESS),
  },
  {
    // A call that cannot be made says nothing of the getter: it is thrown, and
    // not read as a token without it.
    name: 'returns Aevo for a token whose getter cannot be called, and fails its standard with the failure of the call',
    code: { [PROXY_ADDRESS]: aevoCodeWithoutOutstanding },
    storage: {},
    outstanding: 'fails',
    expected: { type: XERC20Type.Aevo },
    standardErrorIncludes: '429 Too Many Requests',
  },
  {
    // Standard wins over Aevo, so the missing getter says nothing of it.
    name: 'prefers Standard over Aevo for a token without the outstanding getter',
    code: {
      [PROXY_ADDRESS]: `${aevoCodeWithoutOutstanding}${setLimitsSelector}`,
    },
    storage: {},
    expected: { type: XERC20Type.Standard },
  },
  {
    // Missing one selector means the token cannot be read and written through
    // the Aevo interface, so it is not taken for one.
    name: 'throws when only some of the Aevo selectors are present',
    code: {
      [PROXY_ADDRESS]: ensure0x(
        AEVO_XERC20_SELECTORS.slice(1).map(strip0x).join(''),
      ),
    },
    storage: {
      [EIP1967_IMPLEMENTATION_SLOT]: storageAddress(
        ethers.constants.AddressZero,
      ),
    },
    expected: {
      errorIncludes:
        'does not implement Standard, Velodrome or Aevo XERC20 interface',
    },
  },
  {
    // Nothing behind the address to inspect, so the zero implementation must
    // not be fetched as though it were one.
    name: 'throws when the implementation slot is empty',
    code: { [PROXY_ADDRESS]: '0xdead' },
    storage: {
      [EIP1967_IMPLEMENTATION_SLOT]: storageAddress(
        ethers.constants.AddressZero,
      ),
    },
    expected: {
      errorIncludes:
        'does not implement Standard, Velodrome or Aevo XERC20 interface',
    },
  },
  {
    // Proxy resolves to an implementation that still lacks both selectors.
    name: 'throws when neither the proxy nor its implementation implements a known interface',
    code: {
      [PROXY_ADDRESS]: '0xdead',
      [IMPLEMENTATION_ADDRESS]: '0xbeef',
    },
    storage: {
      [EIP1967_IMPLEMENTATION_SLOT]: storageAddress(IMPLEMENTATION_ADDRESS),
    },
    expected: {
      errorIncludes:
        'does not implement Standard, Velodrome or Aevo XERC20 interface',
    },
  },
  {
    // No bytecode at the address at all.
    name: 'throws when the address has no bytecode',
    code: { [PROXY_ADDRESS]: '0x' },
    storage: {},
    expected: { errorIncludes: 'Contract has no bytecode' },
  },
  {
    // The slot points to an address that holds nothing, so there is no
    // implementation to inspect, which says nothing of the type of the token.
    name: 'throws when the implementation of the proxy has no bytecode',
    code: { [PROXY_ADDRESS]: '0xdead', [IMPLEMENTATION_ADDRESS]: '0x' },
    storage: {
      [EIP1967_IMPLEMENTATION_SLOT]: storageAddress(IMPLEMENTATION_ADDRESS),
    },
    expected: {
      errorIncludes: `Its EIP-1967 implementation ${IMPLEMENTATION_ADDRESS} has no bytecode`,
    },
  },
];

// Answers the code and storage reads of the case, and throws for any other.
function stubChain(
  sandbox: sinon.SinonSandbox,
  multiProvider: MultiProvider,
  c: Case,
): void {
  const provider = multiProvider.getProvider(TestChainName.test1);

  sandbox.stub(provider, 'getCode').callsFake(async (addressOrName) => {
    const target = await addressOrName;
    const code = c.code[target];
    if (code === undefined) {
      throw new Error(`Unexpected getCode call for ${target}`);
    }
    return code;
  });
  sandbox
    .stub(provider, 'getStorageAt')
    .callsFake(async (_addressOrName, position) => {
      const slot = await position;
      const value = typeof slot === 'string' ? c.storage[slot] : undefined;
      if (value === undefined) {
        throw new Error(`Unexpected getStorageAt call for slot ${slot}`);
      }
      return value;
    });
  sandbox.stub(provider, 'call').callsFake(async (transaction) => {
    const to = await transaction.to;
    const data = await transaction.data;
    if (
      c.outstanding === undefined ||
      to !== (c.address ?? PROXY_ADDRESS) ||
      typeof data !== 'string' ||
      !data.startsWith(AEVO_OUTSTANDING_SELECTOR)
    ) {
      throw new Error(`Unexpected call to ${to} with ${data}`);
    }
    if (c.outstanding === 'fails') throw TRANSPORT_FAILURE;
    if (c.outstanding === 'reverts') {
      throw Object.assign(new Error('call revert exception'), {
        code: 'CALL_EXCEPTION',
        data: '0x',
      });
    }
    return ethers.utils.hexZeroPad('0x00', 32);
  });
}

describe('deriveXERC20TokenType', () => {
  let sandbox: sinon.SinonSandbox;
  let multiProvider: MultiProvider;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    multiProvider = MultiProvider.createTestMultiProvider();
  });

  afterEach(() => {
    sandbox.restore();
  });

  for (const c of cases) {
    it(c.name, async () => {
      stubChain(sandbox, multiProvider, c);

      if ('type' in c.expected) {
        const type = await deriveXERC20TokenType(
          multiProvider,
          TestChainName.test1,
          c.address ?? PROXY_ADDRESS,
        );
        expect(type).to.equal(c.expected.type);
      } else {
        let error: Error | undefined;
        try {
          await deriveXERC20TokenType(
            multiProvider,
            TestChainName.test1,
            c.address ?? PROXY_ADDRESS,
          );
        } catch (e) {
          if (e instanceof Error) {
            error = e;
          }
        }
        expect(error).to.be.instanceOf(Error);
        expect(error?.message).to.include(c.expected.errorIncludes);
      }
    });
  }
});

describe('deriveEvmXERC20Standard', () => {
  let sandbox: sinon.SinonSandbox;
  let multiProvider: MultiProvider;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    multiProvider = MultiProvider.createTestMultiProvider();
  });

  afterEach(() => {
    sandbox.restore();
  });

  const standardOf: Record<XERC20Type, TokenStandard> = {
    [XERC20Type.Standard]: TokenStandard.EvmHypXERC20,
    [XERC20Type.Velo]: TokenStandard.EvmHypVSXERC20,
    [XERC20Type.Aevo]: TokenStandard.EvmHypAevoXERC20,
  };

  // The standard follows the type of the token, and a token of no known type
  // keeps the standard of an xERC20 router instead of failing the export. A
  // token that cannot be read at all is no answer, and is rejected, as is an
  // Aevo token the Aevo adapter could not read the limits of.
  function rejection(c: Case): string | undefined {
    if (c.standardErrorIncludes !== undefined) return c.standardErrorIncludes;
    return 'errorIncludes' in c.expected &&
      c.expected.errorIncludes.includes('has no bytecode')
      ? c.expected.errorIncludes
      : undefined;
  }

  function expectedStandard(c: Case): TokenStandard {
    return 'type' in c.expected
      ? standardOf[c.expected.type]
      : TokenStandard.EvmHypXERC20;
  }

  it('rethrows a failure of the call of the getter as it is, not as a token without it', async () => {
    const c = cases.find(({ outstanding }) => outstanding === 'fails');
    assert(c, 'Expected a case whose getter cannot be called');
    stubChain(sandbox, multiProvider, c);

    await expect(
      deriveEvmXERC20Standard(
        multiProvider,
        TestChainName.test1,
        c.address ?? PROXY_ADDRESS,
      ),
    ).to.be.rejectedWith(TRANSPORT_FAILURE);
  });

  for (const c of cases) {
    const rejected = rejection(c);

    it(`${c.name}: ${rejected === undefined ? expectedStandard(c) : 'is rejected'}`, async () => {
      stubChain(sandbox, multiProvider, c);
      const derive = deriveEvmXERC20Standard(
        multiProvider,
        TestChainName.test1,
        c.address ?? PROXY_ADDRESS,
      );

      if (rejected === undefined) {
        expect(await derive).to.equal(expectedStandard(c));
      } else {
        await expect(derive).to.be.rejectedWith(rejected);
      }
    });
  }
});

describe('Aevo token fixture', () => {
  const aevoSelectors = Object.values(AEVO_SELECTORS);
  const absentSelectors = AEVO_ABSENT_SELECTORS;

  it('detects on the selectors the Aevo adapter encodes', () => {
    expect(AEVO_XERC20_SELECTORS).to.have.members(aevoSelectors);
  });

  // The owner of the token is read and handed over through two more functions,
  // which do not identify it.
  it('encodes the owner functions with the selectors the token carries', () => {
    const abi = new ethers.utils.Interface(XERC20_AEVO_ABI);

    expect(abi.getSighash('owner')).to.equal(AEVO_OWNER_SELECTORS.owner);
    expect(abi.getSighash('setOwner')).to.equal(AEVO_OWNER_SELECTORS.setOwner);
    for (const selector of Object.values(AEVO_OWNER_SELECTORS)) {
      expect(AEVO_XERC20_SELECTORS).to.not.include(selector);
    }
  });

  for (const implementation of [
    AEVO_USDC_IMPLEMENTATION,
    AEVO_WETH_IMPLEMENTATION,
  ]) {
    it(`carries every Aevo selector and no Standard or Velodrome one in ${implementation}`, () => {
      const code = aevoTokenCode(implementation);
      for (const selector of aevoSelectors) {
        expect(code).to.include(strip0x(selector));
      }
      for (const selector of absentSelectors) {
        expect(code).to.not.include(strip0x(selector));
      }
    });

    it(`carries the outstanding getter in ${implementation}`, () => {
      expect(aevoTokenCode(implementation)).to.include('963aee20');
    });

    it(`carries owner() and setOwner(address) in ${implementation}`, () => {
      const code = aevoTokenCode(implementation);
      for (const selector of Object.values(AEVO_OWNER_SELECTORS)) {
        expect(code).to.include(strip0x(selector));
      }
    });
  }

  it('records a proxy that holds none of the selectors itself', () => {
    const code = aevoTokenCode(AEVO_USDC_PROXY);
    expect((code.length - 2) / 2).to.equal(657);
    for (const selector of [
      ...aevoSelectors,
      ...absentSelectors,
      AEVO_OUTSTANDING_SELECTOR,
    ]) {
      expect(code).to.not.include(strip0x(selector));
    }
  });

  it('pins the selector of the outstanding getter', () => {
    expect(AEVO_OUTSTANDING_SELECTOR).to.equal('0x963aee20');
  });
});

describe('UnknownXERC20TypeError', () => {
  let sandbox: sinon.SinonSandbox;
  let multiProvider: MultiProvider;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    multiProvider = MultiProvider.createTestMultiProvider();
  });

  afterEach(() => {
    sandbox.restore();
  });

  // Callers tell an undetectable interface apart from a failure to read the
  // bytecode by the error type, so the type is part of the contract.
  it('is thrown when the contract implements neither known interface', async () => {
    const provider = multiProvider.getProvider(TestChainName.test1);
    sandbox.stub(provider, 'getCode').resolves('0xbeef');
    sandbox
      .stub(provider, 'getStorageAt')
      .resolves(storageAddress(PROXY_ADDRESS));

    let thrown: unknown;
    try {
      await deriveXERC20TokenType(
        multiProvider,
        TestChainName.test1,
        PROXY_ADDRESS,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.be.instanceOf(UnknownXERC20TypeError);
  });

  it('is not thrown when the implementation of the proxy has no bytecode', async () => {
    const provider = multiProvider.getProvider(TestChainName.test1);
    sandbox
      .stub(provider, 'getCode')
      .callsFake(async (address) =>
        (await address) === IMPLEMENTATION_ADDRESS ? '0x' : '0xdead',
      );
    sandbox
      .stub(provider, 'getStorageAt')
      .resolves(storageAddress(IMPLEMENTATION_ADDRESS));

    let thrown: unknown;
    try {
      await deriveXERC20TokenType(
        multiProvider,
        TestChainName.test1,
        PROXY_ADDRESS,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.be.instanceOf(Error);
    expect(thrown).to.not.be.instanceOf(UnknownXERC20TypeError);
  });

  it('is not thrown when the bytecode cannot be read at all', async () => {
    const provider = multiProvider.getProvider(TestChainName.test1);
    const transientError = new Error('Invalid response from provider');
    sandbox.stub(provider, 'getCode').rejects(transientError);

    let thrown: unknown;
    try {
      await deriveXERC20TokenType(
        multiProvider,
        TestChainName.test1,
        PROXY_ADDRESS,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.equal(transientError);
  });
});

const XERC20_ADDRESS = '0x6666666666666666666666666666666666666666';
const BRIDGE_A = '0x4444444444444444444444444444444444444444';
const BRIDGE_B = '0x5555555555555555555555555555555555555555';
// A mainnet warp route router, which its xERC20 holds bridge limits for like
// any other bridge. Those limits are reported as warpRouteLimits, never as an
// extra bridge.
const WARP_ROUTER = '0x88AC0fC430130983c0DDEB4C22574056D8340Ca8';

const rateLimitsSelector = ethers.utils.id('rateLimits(address)').slice(0, 10);
const mintingMaxLimitOfSelector = ethers.utils
  .id('mintingMaxLimitOf(address)')
  .slice(0, 10);
const burningMaxLimitOfSelector = ethers.utils
  .id('burningMaxLimitOf(address)')
  .slice(0, 10);

type OnChainLimits =
  | { bufferCap: string; rateLimitPerSecond: string }
  | { mint: string; burn: string };

// The scan reads the bridge out of topics[1] and nothing else, so the payload
// only matters to latestConfigurationPerBridge, which parses it.
function configurationChangedLog({
  bridge,
  bufferCap = 100,
  rateLimitPerSecond = 1,
  blockNumber,
  logIndex = 0,
}: {
  bridge: string;
  bufferCap?: number;
  rateLimitPerSecond?: number;
  blockNumber: number;
  logIndex?: number;
}): GetEventLogsResponse {
  return {
    address: XERC20_ADDRESS,
    blockNumber,
    data: ethers.utils.defaultAbiCoder.encode(
      ['uint112', 'uint128'],
      [bufferCap, rateLimitPerSecond],
    ),
    logIndex,
    topics: [
      CONFIGURATION_CHANGED_EVENT_SELECTOR,
      ethers.utils.hexZeroPad(bridge, 32),
    ],
    transactionHash: ethers.utils.hexZeroPad(`0x${blockNumber}`, 32),
    transactionIndex: 0,
  };
}

function bridgeLimitsSetLog({
  bridge,
  blockNumber,
  logIndex = 0,
}: {
  bridge: string;
  blockNumber: number;
  logIndex?: number;
}): GetEventLogsResponse {
  return {
    address: XERC20_ADDRESS,
    blockNumber,
    data: ethers.utils.defaultAbiCoder.encode(
      ['uint256', 'uint256'],
      [100, 100],
    ),
    logIndex,
    topics: [
      BRIDGE_LIMITS_SET_EVENT_SELECTOR,
      ethers.utils.hexZeroPad(bridge, 32),
    ],
    transactionHash: ethers.utils.hexZeroPad(`0x${blockNumber}`, 32),
    transactionIndex: 0,
  };
}

interface BridgeCase {
  name: string;
  type: XERC20Type;
  logs: GetEventLogsResponse[];
  warpRouteAddress?: string;
  // Limits the token reports for each bridge, keyed by lowercased address. A
  // bridge missing from here is one the token holds no limits for.
  onChainLimits: Record<string, OnChainLimits>;
  expected: XERC20TokenExtraBridgesLimits[];
}

const bridgeCases: BridgeCase[] = [
  {
    // Every non-lockbox bridge used to be dropped, because the reader kept only
    // the addresses answering the lockbox XERC20() getter.
    name: 'reports a configured bridge that is not a lockbox',
    type: XERC20Type.Velo,
    logs: [configurationChangedLog({ bridge: BRIDGE_A, blockNumber: 10 })],
    onChainLimits: {
      [BRIDGE_A.toLowerCase()]: { bufferCap: '100', rateLimitPerSecond: '1' },
    },
    expected: [
      {
        lockbox: BRIDGE_A.toLowerCase(),
        limits: {
          type: XERC20Type.Velo,
          bufferCap: '100',
          rateLimitPerSecond: '1',
        },
      },
    ],
  },
  {
    // The route's router holds bridge limits like any other bridge, and the
    // lockbox probe used to be what kept it out of the extra bridges.
    name: "omits the warp route's own router",
    type: XERC20Type.Velo,
    logs: [
      configurationChangedLog({ bridge: WARP_ROUTER, blockNumber: 10 }),
      configurationChangedLog({ bridge: BRIDGE_A, blockNumber: 11 }),
    ],
    warpRouteAddress: WARP_ROUTER,
    onChainLimits: {
      [WARP_ROUTER.toLowerCase()]: {
        bufferCap: '300',
        rateLimitPerSecond: '3',
      },
      [BRIDGE_A.toLowerCase()]: { bufferCap: '100', rateLimitPerSecond: '1' },
    },
    expected: [
      {
        lockbox: BRIDGE_A.toLowerCase(),
        limits: {
          type: XERC20Type.Velo,
          bufferCap: '100',
          rateLimitPerSecond: '1',
        },
      },
    ],
  },
  {
    // The event is a record of a past announcement, not of the current state:
    // only what the token holds now decides whether a bridge is active.
    name: 'reports a bridge on the limits it holds, not the ones it was announced with',
    type: XERC20Type.Velo,
    logs: [configurationChangedLog({ bridge: BRIDGE_A, blockNumber: 20 })],
    onChainLimits: {
      [BRIDGE_A.toLowerCase()]: { bufferCap: '900', rateLimitPerSecond: '9' },
    },
    expected: [
      {
        lockbox: BRIDGE_A.toLowerCase(),
        limits: {
          type: XERC20Type.Velo,
          bufferCap: '900',
          rateLimitPerSecond: '9',
        },
      },
    ],
  },
  {
    name: 'drops a bridge the token holds no limits for',
    type: XERC20Type.Velo,
    logs: [configurationChangedLog({ bridge: BRIDGE_A, blockNumber: 10 })],
    onChainLimits: {
      [BRIDGE_A.toLowerCase()]: { bufferCap: '0', rateLimitPerSecond: '0' },
    },
    expected: [],
  },
  {
    name: 'keeps a bridge where either limit is non zero',
    type: XERC20Type.Velo,
    logs: [
      configurationChangedLog({ bridge: BRIDGE_A, blockNumber: 10 }),
      configurationChangedLog({ bridge: BRIDGE_B, blockNumber: 11 }),
    ],
    onChainLimits: {
      [BRIDGE_A.toLowerCase()]: { bufferCap: '0', rateLimitPerSecond: '7' },
      [BRIDGE_B.toLowerCase()]: { bufferCap: '9', rateLimitPerSecond: '0' },
    },
    expected: [
      {
        lockbox: BRIDGE_A.toLowerCase(),
        limits: {
          type: XERC20Type.Velo,
          bufferCap: '0',
          rateLimitPerSecond: '7',
        },
      },
      {
        lockbox: BRIDGE_B.toLowerCase(),
        limits: {
          type: XERC20Type.Velo,
          bufferCap: '9',
          rateLimitPerSecond: '0',
        },
      },
    ],
  },
  {
    // A bridge is announced again every time its limits change, so the same
    // address arrives many times over a token's history.
    name: 'reports a bridge announced more than once only once',
    type: XERC20Type.Velo,
    logs: [
      configurationChangedLog({ bridge: BRIDGE_A, blockNumber: 10 }),
      configurationChangedLog({ bridge: BRIDGE_A, blockNumber: 20 }),
      configurationChangedLog({
        bridge: BRIDGE_A,
        blockNumber: 20,
        logIndex: 4,
      }),
    ],
    onChainLimits: {
      [BRIDGE_A.toLowerCase()]: { bufferCap: '100', rateLimitPerSecond: '1' },
    },
    expected: [
      {
        lockbox: BRIDGE_A.toLowerCase(),
        limits: {
          type: XERC20Type.Velo,
          bufferCap: '100',
          rateLimitPerSecond: '1',
        },
      },
    ],
  },
  {
    // A Standard token announces its bridges through a different event and
    // exposes no rateLimits getter, so it used to be invisible on both counts.
    name: 'discovers and reports the bridges of a Standard xERC20',
    type: XERC20Type.Standard,
    logs: [
      bridgeLimitsSetLog({ bridge: BRIDGE_A, blockNumber: 10 }),
      bridgeLimitsSetLog({ bridge: BRIDGE_B, blockNumber: 11 }),
    ],
    onChainLimits: {
      [BRIDGE_A.toLowerCase()]: { mint: '400', burn: '500' },
      [BRIDGE_B.toLowerCase()]: { mint: '0', burn: '0' },
    },
    expected: [
      {
        lockbox: BRIDGE_A.toLowerCase(),
        limits: { type: XERC20Type.Standard, mint: '400', burn: '500' },
      },
    ],
  },
];

const DEPLOYMENT_BLOCK = 5755967;

describe('getExtraLockBoxConfigs', () => {
  let sandbox: sinon.SinonSandbox;
  let multiProvider: MultiProvider;
  let deploymentBlock: sinon.SinonStub;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    multiProvider = MultiProvider.createTestMultiProvider();
    deploymentBlock = sandbox
      .stub(EvmEventLogsReader.prototype, 'getContractDeploymentBlock')
      .resolves(DEPLOYMENT_BLOCK);
  });

  afterEach(() => {
    sandbox.restore();
  });

  // Serves the token's bytecode, which is what the type derivation reads, and
  // the limit getter of that type. An address the token holds no limits for
  // reverts with empty return data, like a getter reading an unset entry on a
  // contract that does not have it.
  function stubXERC20(
    type: XERC20Type,
    onChainLimits: Record<string, OnChainLimits>,
  ): void {
    const provider = multiProvider.getProvider(TestChainName.test1);
    sandbox
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
      const limits = onChainLimits[bridge.toLowerCase()];
      if (!limits) {
        throw Object.assign(new Error('call revert exception'), {
          code: 'CALL_EXCEPTION',
          data: '0x',
        });
      }

      if (selector === rateLimitsSelector && 'bufferCap' in limits) {
        return ethers.utils.defaultAbiCoder.encode(
          ['tuple(uint128,uint112,uint32,uint112,uint112)'],
          [[limits.rateLimitPerSecond, limits.bufferCap, 0, 0, 0]],
        );
      }

      if (selector === mintingMaxLimitOfSelector && 'mint' in limits) {
        return ethers.utils.defaultAbiCoder.encode(['uint256'], [limits.mint]);
      }

      if (selector === burningMaxLimitOfSelector && 'burn' in limits) {
        return ethers.utils.defaultAbiCoder.encode(['uint256'], [limits.burn]);
      }

      throw new Error(`Unexpected call ${selector} for ${bridge}`);
    });
  }

  for (const c of bridgeCases) {
    it(c.name, async () => {
      sandbox
        .stub(EvmEventLogsReader.prototype, 'getLogsByTopic')
        .resolves(c.logs);
      stubXERC20(c.type, c.onChainLimits);

      const result = await getExtraLockBoxConfigs({
        chain: TestChainName.test1,
        xERC20Address: XERC20_ADDRESS,
        multiProvider,
        warpRouteAddress: c.warpRouteAddress,
      });

      expect(result).to.deep.equal(c.expected);
    });
  }

  describe('of an Aevo token', () => {
    interface Case {
      name: string;
      type: XERC20Type | undefined;
    }

    // Which other contracts may mint an Aevo token is not modelled, so nothing
    // is scanned and no limit is read, whether the caller knew the type or not.
    const cases: Case[] = [
      {
        name: 'answers none when the caller passes the type',
        type: XERC20Type.Aevo,
      },
      { name: 'answers none when it derives the type', type: undefined },
    ];

    for (const c of cases) {
      it(c.name, async () => {
        const provider = multiProvider.getProvider(TestChainName.test1);
        sandbox
          .stub(provider, 'getCode')
          .resolves(aevoTokenCode(AEVO_USDC_IMPLEMENTATION));
        sandbox.stub(provider, 'call').rejects(new Error('Unexpected call'));
        sandbox
          .stub(EvmEventLogsReader.prototype, 'getLogsByTopic')
          .rejects(new Error('Unexpected log read'));

        const result = await getExtraLockBoxConfigs({
          chain: TestChainName.test1,
          xERC20Address: XERC20_ADDRESS,
          multiProvider,
          warpRouteAddress: WARP_ROUTER,
          type: c.type,
        });

        expect(result).to.deep.equal([]);
        sinon.assert.notCalled(deploymentBlock);
      });
    }
  });

  interface TopicCase {
    name: string;
    type: XERC20Type;
    expectedTopic: string;
  }

  // Querying the wrong signature's topic returns nothing, which reads as a
  // token with no bridges rather than as a scan that asked the wrong question.
  const topicCases: TopicCase[] = [
    {
      name: 'scans the Velodrome event topic for a Velodrome xERC20',
      type: XERC20Type.Velo,
      expectedTopic:
        '0xb4ff6a860e04455b1ce16833b74cde19765c95e55c5e7e4f5a69e9707d8cc96d',
    },
    {
      name: 'scans the Standard event topic for a Standard xERC20',
      type: XERC20Type.Standard,
      expectedTopic:
        '0x93f3bbfe8cfb354ec059175107653f49f6eb479a8622a7d83866ea015435c944',
    },
  ];

  for (const c of topicCases) {
    it(c.name, async () => {
      const fromConfig = sandbox.spy(EvmEventLogsReader, 'fromConfig');
      const getLogsByTopic = sandbox
        .stub(EvmEventLogsReader.prototype, 'getLogsByTopic')
        .resolves([
          configurationChangedLog({ bridge: BRIDGE_A, blockNumber: 10 }),
        ]);
      // Non-empty so the read settles on the first answer; what it asked for is
      // what this pins.
      stubXERC20(c.type, {
        [BRIDGE_A.toLowerCase()]:
          c.type === XERC20Type.Velo
            ? { bufferCap: '1', rateLimitPerSecond: '1' }
            : { mint: '1', burn: '1' },
      });

      await getExtraLockBoxConfigs({
        chain: TestChainName.test1,
        xERC20Address: XERC20_ADDRESS,
        multiProvider,
      });

      expect(fromConfig.calledOnce).to.be.true;
      expect(fromConfig.firstCall.args[0]).to.deep.equal({
        chain: TestChainName.test1,
        paginationBlockRange: 1_000_000,
      });
      expect(
        getLogsByTopic.calledOnceWithExactly({
          contractAddress: XERC20_ADDRESS,
          eventTopic: c.expectedTopic,
          fromBlock: DEPLOYMENT_BLOCK,
        }),
      ).to.be.true;
    });
  }

  // A route's token holds limits for at least the route's own router, so it has
  // announced at least one bridge: an explorer answering with none has failed to
  // answer, which is indistinguishable from a token that has none until the RPC
  // is asked. Two of the six oUSDT chains report exactly this way.
  it('re-reads over the RPC when the explorer announces no bridges', async () => {
    const fromConfig = sandbox.spy(EvmEventLogsReader, 'fromConfig');
    const getLogsByTopic = sandbox.stub(
      EvmEventLogsReader.prototype,
      'getLogsByTopic',
    );
    getLogsByTopic.onFirstCall().resolves([]);
    getLogsByTopic
      .onSecondCall()
      .resolves([
        configurationChangedLog({ bridge: BRIDGE_A, blockNumber: 10 }),
      ]);
    stubXERC20(XERC20Type.Velo, {
      [BRIDGE_A.toLowerCase()]: { bufferCap: '100', rateLimitPerSecond: '1' },
    });

    const result = await getExtraLockBoxConfigs({
      chain: TestChainName.test1,
      xERC20Address: XERC20_ADDRESS,
      multiProvider,
    });

    // The deployment block is resolved once and handed to both reads. Letting
    // the RPC reader derive it is what fails on a chain that serves no archive
    // state, so a second resolution here is the defect this guards.
    expect(deploymentBlock.calledOnce).to.be.true;
    const query = {
      contractAddress: XERC20_ADDRESS,
      eventTopic:
        '0xb4ff6a860e04455b1ce16833b74cde19765c95e55c5e7e4f5a69e9707d8cc96d',
      fromBlock: DEPLOYMENT_BLOCK,
    };
    expect(getLogsByTopic.calledTwice).to.be.true;
    expect(getLogsByTopic.firstCall.args[0]).to.deep.equal(query);
    expect(getLogsByTopic.secondCall.args[0]).to.deep.equal(query);

    expect(fromConfig.calledTwice).to.be.true;
    expect(fromConfig.secondCall.args[0]).to.deep.equal({
      chain: TestChainName.test1,
      paginationBlockRange: 1_000_000,
      useRPC: true,
    });
    expect(result).to.deep.equal([
      {
        lockbox: BRIDGE_A.toLowerCase(),
        limits: {
          type: XERC20Type.Velo,
          bufferCap: '100',
          rateLimitPerSecond: '1',
        },
      },
    ]);
  });

  // The RPC is the reader's own fallback when a chain declares no explorer, so
  // re-reading there would scan the token's whole history a second time to
  // reach the answer it already gave.
  it('does not re-read when the chain declares no block explorer', async () => {
    sandbox.stub(multiProvider, 'tryGetEvmExplorerMetadataList').returns([]);
    const fromConfig = sandbox.spy(EvmEventLogsReader, 'fromConfig');
    sandbox.stub(EvmEventLogsReader.prototype, 'getLogsByTopic').resolves([]);
    stubXERC20(XERC20Type.Velo, {});

    const result = await getExtraLockBoxConfigs({
      chain: TestChainName.test1,
      xERC20Address: XERC20_ADDRESS,
      multiProvider,
    });

    expect(fromConfig.calledOnce).to.be.true;
    expect(result).to.deep.equal([]);
  });

  it('propagates an RPC re-read failure', async () => {
    const getLogsByTopic = sandbox.stub(
      EvmEventLogsReader.prototype,
      'getLogsByTopic',
    );
    getLogsByTopic.onFirstCall().resolves([]);
    getLogsByTopic.onSecondCall().rejects(new Error('rpc down'));
    stubXERC20(XERC20Type.Velo, {});

    await expect(
      getExtraLockBoxConfigs({
        chain: TestChainName.test1,
        xERC20Address: XERC20_ADDRESS,
        multiProvider,
      }),
    ).to.be.rejectedWith('rpc down');
  });

  // A failed log read used to be swallowed into an empty list, which reported
  // a token with extra bridges as having none. The events are the only place
  // the bridge addresses exist, so a failure to read them is the answer.
  it('propagates a log read failure', async () => {
    sandbox
      .stub(EvmEventLogsReader.prototype, 'getLogsByTopic')
      .rejects(new Error('rpc down'));
    stubXERC20(XERC20Type.Velo, {});

    await expect(
      getExtraLockBoxConfigs({
        chain: TestChainName.test1,
        xERC20Address: XERC20_ADDRESS,
        multiProvider,
      }),
    ).to.be.rejectedWith('rpc down');
  });
});

describe('latestConfigurationPerBridge', () => {
  interface OrderingCase {
    name: string;
    logs: GetEventLogsResponse[];
    expected: Record<string, { bufferCap: bigint; rateLimitPerSecond: bigint }>;
  }

  const orderingCases: OrderingCase[] = [
    {
      name: 'keeps only the most recent configuration of a bridge',
      logs: [
        configurationChangedLog({
          bridge: BRIDGE_A,
          bufferCap: 100,
          rateLimitPerSecond: 1,
          blockNumber: 10,
        }),
        configurationChangedLog({
          bridge: BRIDGE_A,
          bufferCap: 500,
          rateLimitPerSecond: 2,
          blockNumber: 20,
        }),
      ],
      expected: {
        [BRIDGE_A.toLowerCase()]: { bufferCap: 500n, rateLimitPerSecond: 2n },
      },
    },
    {
      // A bridge can be reconfigured twice in the same block, so ordering on the
      // block number alone kept the first configuration instead of the last.
      name: 'keeps the highest logIndex configuration of a bridge within a block',
      logs: [
        configurationChangedLog({
          bridge: BRIDGE_A,
          bufferCap: 100,
          rateLimitPerSecond: 1,
          blockNumber: 10,
          logIndex: 3,
        }),
        configurationChangedLog({
          bridge: BRIDGE_A,
          bufferCap: 500,
          rateLimitPerSecond: 2,
          blockNumber: 10,
          logIndex: 7,
        }),
      ],
      expected: {
        [BRIDGE_A.toLowerCase()]: { bufferCap: 500n, rateLimitPerSecond: 2n },
      },
    },
    {
      // The same-block tiebreaker must not depend on the order the logs arrive in
      name: 'keeps the highest logIndex configuration when logs arrive out of order',
      logs: [
        configurationChangedLog({
          bridge: BRIDGE_A,
          bufferCap: 500,
          rateLimitPerSecond: 2,
          blockNumber: 10,
          logIndex: 7,
        }),
        configurationChangedLog({
          bridge: BRIDGE_A,
          bufferCap: 100,
          rateLimitPerSecond: 1,
          blockNumber: 10,
          logIndex: 3,
        }),
      ],
      expected: {
        [BRIDGE_A.toLowerCase()]: { bufferCap: 500n, rateLimitPerSecond: 2n },
      },
    },
    {
      name: 'keeps every bridge that was configured',
      logs: [
        configurationChangedLog({
          bridge: BRIDGE_A,
          bufferCap: 100,
          rateLimitPerSecond: 1,
          blockNumber: 10,
        }),
        configurationChangedLog({
          bridge: BRIDGE_B,
          bufferCap: 200,
          rateLimitPerSecond: 2,
          blockNumber: 11,
        }),
      ],
      expected: {
        [BRIDGE_A.toLowerCase()]: { bufferCap: 100n, rateLimitPerSecond: 1n },
        [BRIDGE_B.toLowerCase()]: { bufferCap: 200n, rateLimitPerSecond: 2n },
      },
    },
  ];

  for (const c of orderingCases) {
    it(c.name, () => {
      const latest = latestConfigurationPerBridge(
        c.logs.map(viemLogFromGetEventLogsResponse),
      );

      expect([...latest.keys()]).to.have.members(Object.keys(c.expected));
      for (const [bridge, limits] of Object.entries(c.expected)) {
        const log = latest.get(bridge);
        assert(log, `Missing configuration for ${bridge}`);
        expect(log.args.bufferCap).to.equal(limits.bufferCap);
        expect(log.args.rateLimitPerSecond).to.equal(limits.rateLimitPerSecond);
      }
    });
  }
});
