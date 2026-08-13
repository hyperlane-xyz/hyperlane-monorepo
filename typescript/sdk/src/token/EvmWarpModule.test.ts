import { expect } from 'chai';
import { BigNumber } from 'ethers';
import sinon from 'sinon';

import { TimelockController__factory } from '@hyperlane-xyz/core';
import { ensure0x } from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
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

type EvmWarpModuleForTest = {
  configWithTimelockProxyAdminOwner(
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): Promise<HypTokenRouterConfig>;
  timelockMatchesConfig(
    timelockAddress: string,
    config: NonNullable<HypTokenRouterConfig['timelock']>,
  ): Promise<boolean>;
};

// Sentinel thrown by the createTokenFeeUpdateTxs stub to short-circuit
// updateSplit immediately after the module.update() call, so the test does not
// need to stub the ~20 downstream create*UpdateTxs helpers.
class ShortCircuit extends Error {}

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

  const actualProxiedConfig = {
    proxyAdmin: {
      address: PROXY_ADMIN_ADDRESS,
      owner: OWNER_ADDRESS,
    },
  } as DerivedTokenRouterConfig;

  const timelockConfig: NonNullable<HypTokenRouterConfig['timelock']> = {
    delay: 259200,
    roles: {
      executor: TIMELOCK_EXECUTOR_ADDRESS,
      proposer: TIMELOCK_PROPOSER_ADDRESS,
    },
  };

  function createModule() {
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

  it('rejects timelock with ownerOverrides.proxyAdmin', async () => {
    sandbox.stub(EvmWarpModule.prototype, 'read').resolves(actualProxiedConfig);

    const module = createModule();

    try {
      await module.updateSplit({
        ...xERC20Config,
        ownerOverrides: {
          proxyAdmin: TIMELOCK_PROPOSER_ADDRESS,
        },
        timelock: timelockConfig,
      });
      expect.fail('expected timelock plus ownerOverrides.proxyAdmin to reject');
    } catch (error) {
      expect((error as Error).message).to.include(
        'Cannot configure timelock with ownerOverrides.proxyAdmin',
      );
    }
  });

  it('rejects timelock while changing ProxyAdmin address', async () => {
    sandbox.stub(EvmWarpModule.prototype, 'read').resolves(actualProxiedConfig);

    const module = createModule();

    try {
      await module.updateSplit({
        ...xERC20Config,
        proxyAdmin: {
          address: OTHER_PROXY_ADMIN_ADDRESS,
          owner: OWNER_ADDRESS,
        },
        timelock: timelockConfig,
      });
      expect.fail('expected timelock plus ProxyAdmin address change to reject');
    } catch (error) {
      expect((error as Error).message).to.include(
        'Cannot configure timelock while changing ProxyAdmin address',
      );
    }
  });

  it('does not reuse a timelock missing self-admin', async () => {
    stubTimelockController({ hasAdminSelf: false });

    const matches = await createModuleForTest().timelockMatchesConfig(
      TIMELOCK_ADDRESS,
      timelockConfig,
    );

    expect(matches).to.equal(false);
  });

  it('propagates transient timelock reads without deploying a replacement', async () => {
    const transientError = Object.assign(new Error('rpc timeout'), {
      code: 'SERVER_ERROR',
    });
    stubTimelockController({
      getMinDelay: async () => {
        throw transientError;
      },
    });
    const deployStub = sandbox.stub(
      HypERC20Deployer.prototype,
      'deployTimelock',
    );

    try {
      await createModuleForTest().configWithTimelockProxyAdminOwner(
        {
          proxyAdmin: {
            address: PROXY_ADMIN_ADDRESS,
            owner: TIMELOCK_ADDRESS,
          },
        } as DerivedTokenRouterConfig,
        {
          ...xERC20Config,
          timelock: timelockConfig,
        },
      );
      expect.fail('expected transient timelock read failure to propagate');
    } catch (error) {
      expect(error).to.equal(transientError);
      expect(deployStub.called).to.equal(false);
    }
  });

  it('reuses a planned timelock deployment across retry attempts', async () => {
    const firstModule = createModuleForTest();
    const secondModule = createModuleForTest();
    sandbox.stub(firstModule, 'timelockMatchesConfig').resolves(false);
    sandbox.stub(secondModule, 'timelockMatchesConfig').resolves(false);
    const deployStub = sandbox
      .stub(HypERC20Deployer.prototype, 'deployTimelock')
      .resolves({
        address: TIMELOCK_ADDRESS,
      } as Awaited<ReturnType<HypERC20Deployer['deployTimelock']>>);
    const actualConfig = {
      proxyAdmin: {
        address: PROXY_ADMIN_ADDRESS,
        owner: OWNER_ADDRESS,
      },
    } as DerivedTokenRouterConfig;
    const expectedConfig = {
      ...xERC20Config,
      timelock: timelockConfig,
    };

    const firstConfig = await firstModule.configWithTimelockProxyAdminOwner(
      actualConfig,
      expectedConfig,
    );
    const secondConfig = await secondModule.configWithTimelockProxyAdminOwner(
      actualConfig,
      expectedConfig,
    );

    expect(deployStub.calledOnce).to.equal(true);
    expect(firstConfig.proxyAdmin?.owner).to.equal(TIMELOCK_ADDRESS);
    expect(secondConfig.proxyAdmin?.owner).to.equal(TIMELOCK_ADDRESS);
  });

  it('pins same-byte ProxyAdmin address casing to the actual address', async () => {
    const module = createModuleForTest();
    sandbox.stub(module, 'timelockMatchesConfig').resolves(true);

    const expectedConfig = await module.configWithTimelockProxyAdminOwner(
      actualProxiedConfig,
      {
        ...xERC20Config,
        proxyAdmin: {
          address: ensure0x(PROXY_ADMIN_ADDRESS.slice(2).toUpperCase()),
          owner: OWNER_ADDRESS,
        },
        timelock: timelockConfig,
      },
    );

    expect(expectedConfig.proxyAdmin?.address).to.equal(PROXY_ADMIN_ADDRESS);
  });
});
