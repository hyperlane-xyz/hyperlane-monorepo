import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { ethers } from 'ethers';
import sinon from 'sinon';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { EvmEventLogsReader } from '../rpc/evm/EvmEventLogsReader.js';
import { GetEventLogsResponse } from '../rpc/evm/types.js';

import { XERC20TokenExtraBridgesLimits, XERC20Type } from './types.js';
import { CONFIGURATION_CHANGED_EVENT_SELECTOR } from './xerc20-abi.js';
import { deriveXERC20TokenType, getExtraLockBoxConfigs } from './xerc20.js';

chai.use(chaiAsPromised);

const PROXY_ADDRESS = '0x1111111111111111111111111111111111111111';
const IMPLEMENTATION_ADDRESS = '0x2222222222222222222222222222222222222222';
const PROXY_ADMIN_ADDRESS = '0x3333333333333333333333333333333333333333';

const setBufferCapSelector = ethers.utils
  .id('setBufferCap(address,uint256)')
  .slice(2, 10)
  .toLowerCase();
const setLimitsSelector = ethers.utils
  .id('setLimits(address,uint256,uint256)')
  .slice(2, 10)
  .toLowerCase();

// EIP-1967 admin slot read by proxyAdmin() / isProxy().
const ADMIN_SLOT =
  '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
// EIP-1967 implementation slot read by proxyImplementation().
const IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

function storageAddress(address: string): string {
  return ethers.utils.hexZeroPad(address, 32);
}

interface Case {
  name: string;
  // Bytecode returned by provider.getCode() keyed by address.
  code: Record<string, string>;
  // Storage values returned by provider.getStorageAt() keyed by slot. When a
  // slot is omitted the stub throws, proving the derivation never reads it.
  storage: Record<string, string>;
  expected: { type: XERC20Type } | { errorIncludes: string };
}

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
    // implementation bytecode carries the Velodrome selector.
    name: 'inspects the implementation bytecode when the Velo token is behind a proxy',
    code: {
      [PROXY_ADDRESS]: '0xdead',
      [IMPLEMENTATION_ADDRESS]: `0x${setBufferCapSelector}`,
    },
    storage: {
      [ADMIN_SLOT]: storageAddress(PROXY_ADMIN_ADDRESS),
      [IMPLEMENTATION_SLOT]: storageAddress(IMPLEMENTATION_ADDRESS),
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
      [ADMIN_SLOT]: storageAddress(PROXY_ADMIN_ADDRESS),
      [IMPLEMENTATION_SLOT]: storageAddress(IMPLEMENTATION_ADDRESS),
    },
    expected: { type: XERC20Type.Standard },
  },
  {
    // Proxy resolves to an implementation that still lacks both selectors.
    name: 'throws when neither the proxy nor its implementation implements a known interface',
    code: {
      [PROXY_ADDRESS]: '0xdead',
      [IMPLEMENTATION_ADDRESS]: '0xbeef',
    },
    storage: {
      [ADMIN_SLOT]: storageAddress(PROXY_ADMIN_ADDRESS),
      [IMPLEMENTATION_SLOT]: storageAddress(IMPLEMENTATION_ADDRESS),
    },
    expected: {
      errorIncludes:
        'does not implement Standard or Velodrome XERC20 interface',
    },
  },
  {
    // No bytecode at the address at all.
    name: 'throws when the address has no bytecode',
    code: { [PROXY_ADDRESS]: '0x' },
    storage: {},
    expected: { errorIncludes: 'Contract has no bytecode' },
  },
];

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

      if ('type' in c.expected) {
        const type = await deriveXERC20TokenType(
          multiProvider,
          TestChainName.test1,
          PROXY_ADDRESS,
        );
        expect(type).to.equal(c.expected.type);
      } else {
        let error: Error | undefined;
        try {
          await deriveXERC20TokenType(
            multiProvider,
            TestChainName.test1,
            PROXY_ADDRESS,
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

const XERC20_ADDRESS = '0x6666666666666666666666666666666666666666';
const BRIDGE_A = '0x4444444444444444444444444444444444444444';
const BRIDGE_B = '0x5555555555555555555555555555555555555555';
// Value returned by a lockbox's XERC20() getter; never asserted on.
const LOCKBOX_XERC20 = '0x7777777777777777777777777777777777777777';

function configurationChangedLog({
  bridge,
  bufferCap,
  rateLimitPerSecond,
  blockNumber,
  logIndex = 0,
}: {
  bridge: string;
  bufferCap: number;
  rateLimitPerSecond: number;
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

interface LockboxCase {
  name: string;
  logs: GetEventLogsResponse[];
  // Bridges whose XERC20() getter resolves. Any other bridge reverts with
  // empty return data, like a contract missing the selector would.
  lockboxBridges: string[];
  expected: XERC20TokenExtraBridgesLimits[];
}

const lockboxCases: LockboxCase[] = [
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
    lockboxBridges: [BRIDGE_A],
    expected: [
      {
        lockbox: BRIDGE_A,
        limits: {
          type: XERC20Type.Velo,
          bufferCap: '500',
          rateLimitPerSecond: '2',
        },
      },
    ],
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
    lockboxBridges: [BRIDGE_A],
    expected: [
      {
        lockbox: BRIDGE_A,
        limits: {
          type: XERC20Type.Velo,
          bufferCap: '500',
          rateLimitPerSecond: '2',
        },
      },
    ],
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
    lockboxBridges: [BRIDGE_A],
    expected: [
      {
        lockbox: BRIDGE_A,
        limits: {
          type: XERC20Type.Velo,
          bufferCap: '500',
          rateLimitPerSecond: '2',
        },
      },
    ],
  },
  {
    // Deduplication must run before the zero-limit filter, otherwise the stale
    // non-zero configuration would keep a deactivated bridge alive.
    name: 'drops a bridge whose most recent configuration zeroes both limits',
    logs: [
      configurationChangedLog({
        bridge: BRIDGE_A,
        bufferCap: 100,
        rateLimitPerSecond: 1,
        blockNumber: 10,
      }),
      configurationChangedLog({
        bridge: BRIDGE_A,
        bufferCap: 0,
        rateLimitPerSecond: 0,
        blockNumber: 20,
      }),
    ],
    lockboxBridges: [BRIDGE_A],
    expected: [],
  },
  {
    name: 'drops a bridge configured with both limits set to zero',
    logs: [
      configurationChangedLog({
        bridge: BRIDGE_A,
        bufferCap: 0,
        rateLimitPerSecond: 0,
        blockNumber: 10,
      }),
    ],
    lockboxBridges: [BRIDGE_A],
    expected: [],
  },
  {
    name: 'keeps bridges where either limit is non zero',
    logs: [
      configurationChangedLog({
        bridge: BRIDGE_A,
        bufferCap: 0,
        rateLimitPerSecond: 7,
        blockNumber: 10,
      }),
      configurationChangedLog({
        bridge: BRIDGE_B,
        bufferCap: 9,
        rateLimitPerSecond: 0,
        blockNumber: 11,
      }),
    ],
    lockboxBridges: [BRIDGE_A, BRIDGE_B],
    expected: [
      {
        lockbox: BRIDGE_A,
        limits: {
          type: XERC20Type.Velo,
          bufferCap: '0',
          rateLimitPerSecond: '7',
        },
      },
      {
        lockbox: BRIDGE_B,
        limits: {
          type: XERC20Type.Velo,
          bufferCap: '9',
          rateLimitPerSecond: '0',
        },
      },
    ],
  },
  {
    name: 'drops bridges that are not lockbox contracts',
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
    lockboxBridges: [BRIDGE_A],
    expected: [
      {
        lockbox: BRIDGE_A,
        limits: {
          type: XERC20Type.Velo,
          bufferCap: '100',
          rateLimitPerSecond: '1',
        },
      },
    ],
  },
  {
    name: 'returns an empty list when no configuration events were emitted',
    logs: [],
    lockboxBridges: [],
    expected: [],
  },
];

describe('getExtraLockBoxConfigs', () => {
  let sandbox: sinon.SinonSandbox;
  let multiProvider: MultiProvider;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    multiProvider = MultiProvider.createTestMultiProvider();
  });

  afterEach(() => {
    sandbox.restore();
  });

  function stubLockboxCalls(lockboxBridges: string[]): void {
    const lockboxes = new Set(lockboxBridges.map((b) => b.toLowerCase()));
    const provider = multiProvider.getProvider(TestChainName.test1);

    sandbox.stub(provider, 'call').callsFake(async (transaction) => {
      const to = await transaction.to;
      if (typeof to === 'string' && lockboxes.has(to.toLowerCase())) {
        return ethers.utils.defaultAbiCoder.encode(
          ['address'],
          [LOCKBOX_XERC20],
        );
      }

      throw Object.assign(new Error('call revert exception'), {
        code: 'CALL_EXCEPTION',
        data: '0x',
      });
    });
  }

  for (const c of lockboxCases) {
    it(c.name, async () => {
      sandbox
        .stub(EvmEventLogsReader.prototype, 'getLogsByTopic')
        .resolves(c.logs);
      stubLockboxCalls(c.lockboxBridges);

      const result = await getExtraLockBoxConfigs({
        chain: TestChainName.test1,
        xERC20Address: XERC20_ADDRESS,
        multiProvider,
      });

      expect(result).to.deep.equal(c.expected);
    });
  }

  it('reads the ConfigurationChanged logs with the xERC20 scan block range', async () => {
    const fromConfig = sandbox.spy(EvmEventLogsReader, 'fromConfig');
    const getLogsByTopic = sandbox
      .stub(EvmEventLogsReader.prototype, 'getLogsByTopic')
      .resolves([]);
    stubLockboxCalls([]);

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
        eventTopic: CONFIGURATION_CHANGED_EVENT_SELECTOR,
      }),
    ).to.be.true;
  });

  // A failed log read used to be swallowed into an empty list, which reported
  // a token with extra lockboxes as having none.
  it('propagates a log read failure instead of reporting no lockboxes', async () => {
    sandbox
      .stub(EvmEventLogsReader.prototype, 'getLogsByTopic')
      .rejects(new Error('rpc down'));
    stubLockboxCalls([]);

    await expect(
      getExtraLockBoxConfigs({
        chain: TestChainName.test1,
        xERC20Address: XERC20_ADDRESS,
        multiProvider,
      }),
    ).to.be.rejectedWith('rpc down');
  });
});
