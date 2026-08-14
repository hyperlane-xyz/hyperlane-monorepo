import { expect } from 'chai';
import { BigNumber } from 'ethers';
import sinon from 'sinon';

import {
  ProxyAdmin__factory,
  TimelockController__factory,
} from '@hyperlane-xyz/core';

import { TestChainName } from '../consts/testChains.js';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import {
  CANCELLER_ROLE,
  EXECUTOR_ROLE,
  PROPOSER_ROLE,
  TIMELOCK_ADMIN_ROLE,
} from '../timelock/evm/constants.js';

import { EvmWarpModule } from './EvmWarpModule.js';
import { EvmXERC20Module } from './EvmXERC20Module.js';
import { TokenType } from './config.js';
import { HypERC20Deployer } from './deploy.js';
import {
  DerivedTokenRouterConfig,
  HypTokenRouterConfig,
  XERC20Type,
} from './types.js';

const TOKEN_ADDRESS = '0x1111111111111111111111111111111111111111';
const MAILBOX_ADDRESS = '0x2222222222222222222222222222222222222222';
const OWNER_ADDRESS = '0x3333333333333333333333333333333333333333';
const ROUTER_ADDRESS = '0x4444444444444444444444444444444444444444';
const PROXY_ADMIN_ADDRESS = '0x5555555555555555555555555555555555555555';
const OTHER_PROXY_ADMIN_ADDRESS = '0x6666666666666666666666666666666666666666';
const TIMELOCK_PROPOSER_ADDRESS = '0x7777777777777777777777777777777777777777';
const TIMELOCK_EXECUTOR_ADDRESS = '0x8888888888888888888888888888888888888888';
const TIMELOCK_ADDRESS = '0x9999999999999999999999999999999999999999';
const OTHER_TIMELOCK_ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

type EvmWarpModuleForTest = {
  configWithTimelockProxyAdminOwner(
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): Promise<HypTokenRouterConfig>;
  timelockMatchesConfig(
    timelockAddress: string,
    config: NonNullable<HypTokenRouterConfig['timelock']>,
    codeAlreadyVerified?: boolean,
  ): Promise<boolean>;
};

// Sentinel thrown by the createTokenFeeUpdateTxs stub to short-circuit
// updateSplit immediately after the module.update() call, so the test does not
// need to stub the ~20 downstream create*UpdateTxs helpers.
class ShortCircuit extends Error {}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) throw error;
  return error.message;
}

describe('EvmWarpModule', () => {
  let multiProvider: MultiProvider;
  let sandbox: sinon.SinonSandbox;

  const xERC20Config: HypTokenRouterConfig = {
    type: TokenType.XERC20,
    token: TOKEN_ADDRESS,
    mailbox: MAILBOX_ADDRESS,
    owner: OWNER_ADDRESS,
    xERC20: {
      warpRouteLimits: {
        type: XERC20Type.Standard,
        mint: '1000000000000000000',
        burn: '1000000000000000000',
      },
    },
  };

  const timelockConfig: NonNullable<HypTokenRouterConfig['timelock']> = {
    delay: 259200,
    roles: {
      executor: TIMELOCK_EXECUTOR_ADDRESS,
      proposer: TIMELOCK_PROPOSER_ADDRESS,
    },
  };

  function proxiedConfig(owner = OWNER_ADDRESS) {
    // CAST: only proxyAdmin fields are read by the tested planning helper.
    return {
      proxyAdmin: { address: PROXY_ADMIN_ADDRESS, owner },
    } as DerivedTokenRouterConfig;
  }

  function configWithTimelock(
    proxyAdmin?: HypTokenRouterConfig['proxyAdmin'],
  ): HypTokenRouterConfig {
    return {
      ...xERC20Config,
      ...(proxyAdmin ? { proxyAdmin } : {}),
      timelock: timelockConfig,
    };
  }

  function stubDeployTimelocks(...addresses: string[]) {
    const deployStub = sandbox.stub(
      HyperlaneDeployer.prototype,
      'deployTimelock',
    );
    for (const [index, address] of addresses.entries()) {
      deployStub.onCall(index).resolves(
        // CAST: test needs only deployTimelock's returned address.
        { address } as Awaited<ReturnType<HypERC20Deployer['deployTimelock']>>,
      );
    }
    return deployStub;
  }

  function stubContractCode(...codes: string[]) {
    const provider = multiProvider.getProvider(TestChainName.test1);
    const getCode = sandbox.stub(provider, 'getCode');
    for (const [index, code] of codes.entries()) {
      getCode.onCall(index).resolves(code);
    }
    if (codes.length === 1) getCode.resolves(codes[0]);
    sandbox.stub(multiProvider, 'getProvider').returns(provider);
    return getCode;
  }

  function createModule() {
    // CAST: deploy-time fixture only needs the address fields used by update planning.
    return new EvmWarpModule(multiProvider, {
      chain: TestChainName.test1,
      config: xERC20Config,
      addresses: { deployedTokenRoute: ROUTER_ADDRESS },
    } as ConstructorParameters<typeof EvmWarpModule>[1]);
  }

  function createModuleForTest() {
    // CAST: tests intentionally exercise private planning helpers directly.
    return createModule() as unknown as EvmWarpModuleForTest;
  }

  function stubTimelockController({
    hasAdminSelf = true,
    getMinDelay = async () => BigNumber.from(timelockConfig.delay),
  }: {
    hasAdminSelf?: boolean;
    getMinDelay?: () => Promise<BigNumber>;
  }) {
    return sandbox.stub(TimelockController__factory, 'connect').returns({
      getMinDelay,
      hasRole: async (role: string, account: string) => {
        if (role === PROPOSER_ROLE)
          return account === timelockConfig.roles.proposer;
        if (role === EXECUTOR_ROLE)
          return account === timelockConfig.roles.executor;
        if (role === CANCELLER_ROLE)
          return account === timelockConfig.roles.proposer;
        if (role === TIMELOCK_ADMIN_ROLE)
          return hasAdminSelf && account === TIMELOCK_ADDRESS;
        return false;
      },
      // CAST: test stub implements only the TimelockController methods under test.
    } as ReturnType<typeof TimelockController__factory.connect>);
  }

  beforeEach(() => {
    multiProvider = MultiProvider.createTestMultiProvider();
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  // Locks the ownership gate at the real caller. updateSplit must invoke
  // module.update(config) WITHOUT { includeOwnership: true }, so the warp
  // apply/read path never emits XERC20 ownership-transfer txs. Asserting only at
  // the EvmXERC20Module level would stay green if someone flipped this call site.
  it('calls XERC20 module.update without includeOwnership from updateSplit', async () => {
    const updateStub = sandbox
      .stub(EvmXERC20Module.prototype, 'update')
      .resolves([]);

    // read() output is unused before the short-circuit; stub it to avoid network.
    sandbox
      .stub(EvmWarpModule.prototype, 'read')
      // CAST: value is never inspected before createTokenFeeUpdateTxs throws.
      .resolves({} as DerivedTokenRouterConfig);

    sandbox
      .stub(EvmWarpModule.prototype, 'createTokenFeeUpdateTxs')
      .rejects(new ShortCircuit());

    const module = createModule();

    try {
      await module.updateSplit(xERC20Config);
      expect.fail('expected updateSplit to short-circuit via ShortCircuit');
    } catch (error) {
      expect(error).to.be.instanceOf(ShortCircuit);
    }

    expect(updateStub.calledOnce).to.equal(true);
    expect(updateStub.firstCall.args).to.have.length(1);
    expect(updateStub.firstCall.args[1]).to.equal(undefined);
  });

  it('rejects timelock while changing ProxyAdmin address', async () => {
    sandbox.stub(EvmWarpModule.prototype, 'read').resolves(proxiedConfig());

    const module = createModule();

    try {
      await module.updateSplit(
        configWithTimelock({
          address: OTHER_PROXY_ADMIN_ADDRESS,
          owner: OWNER_ADDRESS,
        }),
      );
      expect.fail('expected timelock plus ProxyAdmin address change to reject');
    } catch (error) {
      expect(errorMessage(error)).to.include(
        'Cannot configure timelock while changing ProxyAdmin address',
      );
    }
  });

  it('does not reuse a timelock missing self-admin', async () => {
    stubContractCode('0x1234');
    stubTimelockController({ hasAdminSelf: false });

    const matches = await createModuleForTest().timelockMatchesConfig(
      TIMELOCK_ADDRESS,
      timelockConfig,
    );

    expect(matches).to.equal(false);
  });

  it('does not call the timelock ABI for an EOA ProxyAdmin owner', async () => {
    const getCodeStub = stubContractCode('0x');
    const connectStub = sandbox.stub(TimelockController__factory, 'connect');

    const matches = await createModuleForTest().timelockMatchesConfig(
      OWNER_ADDRESS,
      timelockConfig,
    );

    expect(matches).to.equal(false);
    expect(getCodeStub.calledOnce).to.equal(true);
    expect(connectStub.called).to.equal(false);
  });

  it('propagates transient timelock reads without deploying a replacement', async () => {
    stubContractCode('0x1234');
    const transientError = Object.assign(new Error('rpc timeout'), {
      code: 'SERVER_ERROR',
    });
    stubTimelockController({
      getMinDelay: async () => {
        throw transientError;
      },
    });
    const deployStub = sandbox.stub(
      HyperlaneDeployer.prototype,
      'deployTimelock',
    );

    try {
      await createModuleForTest().configWithTimelockProxyAdminOwner(
        proxiedConfig(TIMELOCK_ADDRESS),
        configWithTimelock(),
      );
      expect.fail('expected transient timelock read failure to propagate');
    } catch (error) {
      expect(error).to.equal(transientError);
      expect(deployStub.called).to.equal(false);
    }
  });

  it('retries cached timelock reads before deploying another controller', async () => {
    const firstModule = createModuleForTest();
    const secondModule = createModuleForTest();
    sandbox.stub(firstModule, 'timelockMatchesConfig').resolves(false);
    const secondMatchStub = sandbox
      .stub(secondModule, 'timelockMatchesConfig')
      .onFirstCall()
      .resolves(false)
      .onSecondCall()
      .resolves(true);
    const getCodeStub = stubContractCode('0x', '0x', '0x1234');
    const deployStub = stubDeployTimelocks(TIMELOCK_ADDRESS);
    const actualConfig = proxiedConfig();
    const expectedConfig = configWithTimelock();

    await firstModule.configWithTimelockProxyAdminOwner(
      actualConfig,
      expectedConfig,
    );
    const secondConfig = await secondModule.configWithTimelockProxyAdminOwner(
      actualConfig,
      expectedConfig,
    );

    expect(deployStub.callCount).to.equal(1);
    expect(getCodeStub.callCount).to.equal(3);
    expect(secondMatchStub.calledTwice).to.equal(true);
    expect(secondConfig.proxyAdmin?.owner).to.equal(TIMELOCK_ADDRESS);
  });

  for (const [name, deploy] of [
    [
      'route-wide deploy',
      (
        deployer: HypERC20Deployer,
        config: HypTokenRouterConfig,
      ): Promise<unknown> => deployer.deploy({ [TestChainName.test1]: config }),
    ],
    [
      'direct deployContracts',
      (
        deployer: HypERC20Deployer,
        config: HypTokenRouterConfig,
      ): Promise<unknown> =>
        deployer.deployContracts(TestChainName.test1, config),
    ],
  ] as const) {
    it(`rejects timelock with ownerOverrides.proxyAdmin before ${name} side effects`, async () => {
      const proxyAdminConnectStub = sandbox.stub(
        ProxyAdmin__factory,
        'connect',
      );
      const deployTimelockStub = sandbox.stub(
        HyperlaneDeployer.prototype,
        'deployTimelock',
      );
      const config: HypTokenRouterConfig = {
        ...configWithTimelock({
          address: PROXY_ADMIN_ADDRESS,
          owner: OWNER_ADDRESS,
        }),
        ownerOverrides: { proxyAdmin: OTHER_PROXY_ADMIN_ADDRESS },
      };

      try {
        await deploy(new HypERC20Deployer(multiProvider), config);
        expect.fail('expected conflicting ProxyAdmin ownership to reject');
      } catch (error) {
        expect(errorMessage(error)).to.include(
          'Cannot configure timelock with ownerOverrides.proxyAdmin',
        );
      }

      expect(proxyAdminConnectStub.called).to.equal(false);
      expect(deployTimelockStub.called).to.equal(false);
    });
  }

  it('rejects fresh timelock deploy with foreign-owned supplied ProxyAdmin before deploying', async () => {
    // CAST: ProxyAdmin__factory.connect is stubbed, so the signer object is not inspected.
    sandbox.stub(multiProvider, 'getSigner').returns({} as any);
    sandbox.stub(multiProvider, 'getSignerAddress').resolves(OWNER_ADDRESS);
    sandbox.stub(ProxyAdmin__factory, 'connect').returns({
      address: PROXY_ADMIN_ADDRESS,
      owner: async () => OTHER_PROXY_ADMIN_ADDRESS,
      // CAST: test stub implements only the ProxyAdmin methods under test.
    } as ReturnType<typeof ProxyAdmin__factory.connect>);
    const deployTimelockStub = sandbox.stub(
      HyperlaneDeployer.prototype,
      'deployTimelock',
    );
    const deployProxiedContractStub = sandbox.stub(
      // CAST: protected inherited method is stubbed only to assert it is not called.
      HyperlaneDeployer.prototype as any,
      'deployProxiedContract',
    );

    try {
      await new HypERC20Deployer(multiProvider).deployContracts(
        TestChainName.test1,
        {
          decimals: 18,
          mailbox: MAILBOX_ADDRESS,
          name: 'Token',
          owner: OWNER_ADDRESS,
          proxyAdmin: { address: PROXY_ADMIN_ADDRESS, owner: OWNER_ADDRESS },
          symbol: 'TOKEN',
          timelock: timelockConfig,
          type: TokenType.synthetic,
        },
      );
      expect.fail('expected foreign-owned ProxyAdmin to reject');
    } catch (error) {
      expect(errorMessage(error)).to.include(
        'Cannot configure timelock with supplied ProxyAdmin',
      );
      expect(deployTimelockStub.called).to.equal(false);
      expect(deployProxiedContractStub.called).to.equal(false);
    }
  });

  it('redeploys a cached timelock when the cached address no longer matches', async () => {
    const firstModule = createModuleForTest();
    const secondModule = createModuleForTest();
    sandbox.stub(firstModule, 'timelockMatchesConfig').resolves(false);
    sandbox.stub(secondModule, 'timelockMatchesConfig').resolves(false);
    stubContractCode('0x1234');
    const deployStub = stubDeployTimelocks(
      TIMELOCK_ADDRESS,
      OTHER_TIMELOCK_ADDRESS,
    );
    const actualConfig = proxiedConfig();
    const expectedConfig = configWithTimelock();

    await firstModule.configWithTimelockProxyAdminOwner(
      actualConfig,
      expectedConfig,
    );
    const secondConfig = await secondModule.configWithTimelockProxyAdminOwner(
      actualConfig,
      expectedConfig,
    );

    expect(deployStub.calledTwice).to.equal(true);
    expect(secondConfig.proxyAdmin?.owner).to.equal(OTHER_TIMELOCK_ADDRESS);
  });
});
