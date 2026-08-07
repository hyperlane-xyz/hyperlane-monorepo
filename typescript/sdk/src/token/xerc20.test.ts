import { expect } from 'chai';
import { ethers } from 'ethers';
import sinon from 'sinon';

import { assert } from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { contractDouble } from '../test/contractDouble.js';

import { XERC20Type } from './types.js';
import { CONFIGURATION_CHANGED_EVENT_SELECTOR } from './xerc20-abi.js';
import { deriveXERC20TokenType, getExtraLockBoxConfigs } from './xerc20.js';

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

const XERC20_ADDRESS = '0x4444444444444444444444444444444444444444';
const LOCKBOX_ADDRESS = '0x5555555555555555555555555555555555555555';
const DEPLOYMENT_TX =
  '0x9fc76417374aa880d4449a1f7f31ec597f00b1f6f3dd2d66f4c9c6c445836d8b';

// A ConfigurationChanged log in the shape an Etherscan-like explorer returns.
function configurationChangedLog(blockNumber: number) {
  return {
    address: XERC20_ADDRESS,
    blockNumber: ethers.utils.hexValue(blockNumber),
    // bufferCap then rateLimitPerSecond, both non-zero so the bridge counts as
    // active.
    data: ethers.utils.hexConcat([
      ethers.utils.hexZeroPad(ethers.utils.hexlify(1000), 32),
      ethers.utils.hexZeroPad(ethers.utils.hexlify(5), 32),
    ]),
    gasPrice: '0x1',
    gasUsed: '0x1',
    logIndex: '0x0',
    timeStamp: '0x64000000',
    topics: [
      CONFIGURATION_CHANGED_EVENT_SELECTOR,
      ethers.utils.hexZeroPad(LOCKBOX_ADDRESS, 32),
    ],
    transactionHash: DEPLOYMENT_TX,
    transactionIndex: '0x0',
  };
}

describe('getExtraLockBoxConfigs', () => {
  let sandbox: sinon.SinonSandbox;
  let multiProvider: MultiProvider;
  let rpcGetLogs: sinon.SinonStub;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    multiProvider = MultiProvider.createTestMultiProvider();

    rpcGetLogs = sandbox.stub().resolves([]);
    sandbox.stub(multiProvider, 'getProvider').returns(
      contractDouble<ethers.providers.Provider>({
        // ethers rejects a provider that does not identify itself as one.
        _isProvider: true,
        // Non-empty so assertIsContractAddress passes.
        getCode: sandbox.stub().resolves('0x60006000'),
        getBlockNumber: sandbox.stub().resolves(2_000),
        getTransactionReceipt: sandbox.stub().resolves({ blockNumber: 1_000 }),
        getLogs: rpcGetLogs,
        // IXERC20Lockbox.XERC20() on the bridge, so it is kept as a lockbox.
        call: sandbox
          .stub()
          .resolves(ethers.utils.hexZeroPad(XERC20_ADDRESS, 32)),
      }),
    );
  });

  afterEach(() => {
    sandbox.restore();
  });

  function stubExplorer(logs: unknown[]): sinon.SinonStub {
    return sandbox.stub(global, 'fetch').callsFake(async (input) => {
      assert(
        typeof input === 'string',
        'expected the reader to request a string URL',
      );
      const url = input;
      const result = url.includes('action=getcontractcreation')
        ? [
            {
              contractAddress: XERC20_ADDRESS,
              contractCreator: LOCKBOX_ADDRESS,
              txHash: DEPLOYMENT_TX,
            },
          ]
        : logs;

      return contractDouble<Response>({
        url,
        json: async () => ({ status: '1', message: 'OK', result }),
      });
    });
  }

  it('reads the configuration logs through the shared reader', async () => {
    const fetchStub = stubExplorer([configurationChangedLog(1_500)]);

    const lockboxes = await getExtraLockBoxConfigs({
      chain: TestChainName.test1,
      xERC20Address: XERC20_ADDRESS,
      multiProvider,
    });

    expect(lockboxes).to.deep.equal([
      {
        lockbox: LOCKBOX_ADDRESS,
        limits: {
          type: XERC20Type.Velo,
          bufferCap: '1000',
          rateLimitPerSecond: '5',
        },
      },
    ]);

    // Through the reader, not the explorer module function: the walk asks for a
    // page, and the recent window is re-read over RPC.
    const logRequest = fetchStub
      .getCalls()
      .map((call) => String(call.args[0]))
      .find((url) => url.includes('action=getLogs'));
    expect(logRequest).to.include('page=1');
    expect(logRequest).to.include('offset=1000');
    expect(rpcGetLogs.called).to.be.true;
  });

  it('returns no lockboxes when the chain has no usable explorer', async () => {
    const fetchStub = stubExplorer([configurationChangedLog(1_500)]);
    sandbox.stub(multiProvider, 'tryGetEvmExplorerMetadata').returns(null);

    const lockboxes = await getExtraLockBoxConfigs({
      chain: TestChainName.test1,
      xERC20Address: XERC20_ADDRESS,
      multiProvider,
    });

    expect(lockboxes).to.deep.equal([]);
    expect(fetchStub.notCalled).to.be.true;
  });
});
