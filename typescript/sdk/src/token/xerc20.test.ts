import { expect } from 'chai';
import { ethers } from 'ethers';
import sinon from 'sinon';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import { XERC20Type } from './types.js';
import { deriveXERC20TokenType } from './xerc20.js';

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
