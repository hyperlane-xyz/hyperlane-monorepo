import { PackageVersioned__factory } from '@hyperlane-xyz/core';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { ethers } from 'ethers';
import sinon from 'sinon';

import { assert } from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import { EIP1967_IMPLEMENTATION_SLOT } from '../deploy/proxy.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { EvmEventLogsReader } from '../rpc/evm/EvmEventLogsReader.js';
import { GetEventLogsResponse } from '../rpc/evm/types.js';
import { missingSelectorError, networkError } from '../test/errors.js';
import { randomAddress } from '../test/testUtils.js';

import { EvmWarpRouteReader } from './EvmWarpRouteReader.js';
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
        .callsFake(async (_address, position) => {
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
