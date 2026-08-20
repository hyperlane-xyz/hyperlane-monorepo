import { Mailbox, Mailbox__factory } from '@hyperlane-xyz/core';
import { addressToBytes32 } from '@hyperlane-xyz/utils';
import { expect } from 'chai';
import sinon from 'sinon';

import { TestChainName, test3 } from '../consts/testChains.js';
import { EvmIsmModule } from '../ism/EvmIsmModule.js';
import { IsmConfig, IsmType } from '../ism/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { RemoteRouters } from '../router/types.js';
import { contractDouble } from '../test/contractDouble.js';
import { randomAddress } from '../test/testUtils.js';
import { TokenType } from '../token/config.js';
import { HypERC20Deployer } from '../token/deploy.js';
import { WarpRouteDeployConfigMailboxRequired } from '../token/types.js';
import { collectHybridIsmNodes } from '../utils/ism.js';

import {
  assertDelayedFlowRouteCoverage,
  assertDelayedFlowRoutePreconditions,
  executeWarpDeploy,
  executeWarpRouteExtensionDeploy,
} from './warp.js';

describe('delayed flow route preconditions', () => {
  const owner = randomAddress();
  const mailbox = randomAddress();

  function delayedFlowIsm(remoteIsms?: Record<string, string>): IsmConfig {
    return {
      type: IsmType.AGGREGATION,
      threshold: 2,
      modules: [
        { type: IsmType.TRUSTED_RELAYER, relayer: owner },
        {
          type: IsmType.DELAYED_FLOW_ROUTER,
          thresholdBps: 10000,
          maxDelay: 60,
          duration: 86400n,
          owner,
          remoteIsms,
        },
      ],
    };
  }

  function chainConfig({
    interchainSecurityModule,
    foreignDeployment,
    remoteRouters,
  }: {
    interchainSecurityModule?: IsmConfig;
    foreignDeployment?: string;
    remoteRouters?: RemoteRouters;
  }): WarpRouteDeployConfigMailboxRequired[string] {
    const hybrid =
      typeof interchainSecurityModule === 'object'
        ? collectHybridIsmNodes(interchainSecurityModule)[0]
        : undefined;
    return {
      type: TokenType.synthetic,
      name: 'Delayed',
      symbol: 'DFR',
      decimals: 18,
      owner,
      mailbox,
      interchainSecurityModule,
      hook: hybrid,
      foreignDeployment,
      remoteRouters,
    };
  }

  const delayedFlowLeg = () =>
    chainConfig({ interchainSecurityModule: delayedFlowIsm() });
  const plainLeg = () => chainConfig({});
  const remoteRouter = () => ({ address: randomAddress() });
  const remoteIsm = () => addressToBytes32(randomAddress());

  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  function stubMailboxNonce(nonce: number) {
    const mailboxDouble = contractDouble<Mailbox>({
      nonce: sandbox.stub().resolves(nonce),
    });
    return sandbox.stub(Mailbox__factory, 'connect').returns(mailboxDouble);
  }

  async function captureError(runner: () => Promise<void>): Promise<string> {
    try {
      await runner();
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return '';
  }

  describe('assertDelayedFlowRouteCoverage', () => {
    const multiProvider = MultiProvider.createTestMultiProvider();

    const assertCoverage = (
      warpDeployConfig: WarpRouteDeployConfigMailboxRequired,
    ) => assertDelayedFlowRouteCoverage({ multiProvider, warpDeployConfig });

    it('accepts a route with no delayed-flow leg at all', () => {
      expect(() =>
        assertCoverage({
          [TestChainName.test1]: plainLeg(),
          [TestChainName.test2]: plainLeg(),
        }),
      ).to.not.throw();
    });

    it('accepts a route where every leg carries an instance', () => {
      expect(() =>
        assertCoverage({
          [TestChainName.test1]: delayedFlowLeg(),
          [TestChainName.test2]: delayedFlowLeg(),
          [TestChainName.test3]: delayedFlowLeg(),
        }),
      ).to.not.throw();
    });

    it('rejects a three-leg route that covers only two legs', () => {
      expect(() =>
        assertCoverage({
          [TestChainName.test1]: delayedFlowLeg(),
          [TestChainName.test2]: delayedFlowLeg(),
          [TestChainName.test3]: plainLeg(),
        }),
      ).to.throw(TestChainName.test3);
    });

    it('rejects extending a delayed-flow route with a plain leg', () => {
      expect(() =>
        assertCoverage({
          [TestChainName.test1]: delayedFlowLeg(),
          [TestChainName.test2]: plainLeg(),
        }),
      ).to.throw(TestChainName.test2);
    });

    it('rejects a leg whose ISM is an address it cannot inspect', () => {
      expect(() =>
        assertCoverage({
          [TestChainName.test1]: delayedFlowLeg(),
          [TestChainName.test2]: chainConfig({
            interchainSecurityModule: randomAddress(),
          }),
        }),
      ).to.throw(TestChainName.test2);
    });

    it('rejects a foreignDeployment leg on a delayed-flow route', () => {
      expect(() =>
        assertCoverage({
          [TestChainName.test1]: delayedFlowLeg(),
          [TestChainName.test2]: chainConfig({
            interchainSecurityModule: delayedFlowIsm(),
            foreignDeployment: randomAddress(),
          }),
        }),
      ).to.throw('foreignDeployment');
    });

    describe('remoteRouters legs outside the route', () => {
      it('rejects a chain-named remoteRouters entry with no counterpart enrolled', () => {
        expect(() =>
          assertCoverage({
            [TestChainName.test1]: chainConfig({
              interchainSecurityModule: delayedFlowIsm(),
              remoteRouters: { [TestChainName.test3]: remoteRouter() },
            }),
            [TestChainName.test2]: delayedFlowLeg(),
          }),
        ).to.throw(TestChainName.test3);
      });

      it('rejects a domain-keyed remoteRouters entry with no counterpart enrolled', () => {
        expect(() =>
          assertCoverage({
            [TestChainName.test1]: chainConfig({
              interchainSecurityModule: delayedFlowIsm(),
              remoteRouters: { [test3.domainId]: remoteRouter() },
            }),
            [TestChainName.test2]: delayedFlowLeg(),
          }),
        ).to.throw(`${TestChainName.test3} (domain ${test3.domainId})`);
      });

      it('sends an unregistered domain to the registry, not to remoteIsms', () => {
        // The only remedy the coverage assert can offer is listing the domain
        // under 'remoteIsms', and canonicalizeRemoteIsms rejects a key that
        // resolves to no known chain — so an unregistered domain has to be
        // rejected here, by the check whose remedy the operator can act on.
        const unregisteredDomain = 999999;
        let thrown: Error | undefined;
        try {
          assertCoverage({
            [TestChainName.test1]: chainConfig({
              interchainSecurityModule: delayedFlowIsm(),
              remoteRouters: { [unregisteredDomain]: remoteRouter() },
            }),
            [TestChainName.test2]: delayedFlowLeg(),
          });
        } catch (error) {
          thrown = error instanceof Error ? error : new Error(String(error));
        }

        expect(thrown?.message).to.include(
          `No chain metadata for ${unregisteredDomain}`,
        );
        expect(thrown?.message).to.include('registry');
        expect(thrown?.message).to.not.include('remoteIsms');
      });

      it('accepts an out-of-route leg enrolled through remoteIsms', () => {
        expect(() =>
          assertCoverage({
            [TestChainName.test1]: chainConfig({
              interchainSecurityModule: delayedFlowIsm({
                [TestChainName.test2]: remoteIsm(),
                [TestChainName.test3]: remoteIsm(),
              }),
              remoteRouters: { [TestChainName.test3]: remoteRouter() },
            }),
            [TestChainName.test2]: delayedFlowLeg(),
          }),
        ).to.not.throw();
      });

      it('accepts remoteRouters entries naming chains of the route, by name or domain', () => {
        expect(() =>
          assertCoverage({
            [TestChainName.test1]: chainConfig({
              interchainSecurityModule: delayedFlowIsm(),
              remoteRouters: {
                [TestChainName.test2]: remoteRouter(),
                [test3.domainId]: remoteRouter(),
              },
            }),
            [TestChainName.test2]: delayedFlowLeg(),
            [TestChainName.test3]: delayedFlowLeg(),
          }),
        ).to.not.throw();
      });

      it('leaves a route without a delayed-flow leg alone', () => {
        expect(() =>
          assertCoverage({
            [TestChainName.test1]: chainConfig({
              remoteRouters: { [TestChainName.test3]: remoteRouter() },
            }),
            [TestChainName.test2]: plainLeg(),
          }),
        ).to.not.throw();
      });
    });

    describe('configured remoteIsms coverage', () => {
      it('accepts remoteIsms that omit route-derived counterparts', () => {
        expect(() =>
          assertCoverage({
            [TestChainName.test1]: chainConfig({
              interchainSecurityModule: delayedFlowIsm({
                [TestChainName.test2]: remoteIsm(),
              }),
            }),
            [TestChainName.test2]: delayedFlowLeg(),
            [TestChainName.test3]: delayedFlowLeg(),
          }),
        ).to.not.throw();
      });

      it('accepts a remoteIsms naming every counterpart, by name or domain', () => {
        expect(() =>
          assertCoverage({
            [TestChainName.test1]: chainConfig({
              interchainSecurityModule: delayedFlowIsm({
                [TestChainName.test2]: remoteIsm(),
                [test3.domainId]: remoteIsm(),
              }),
            }),
            [TestChainName.test2]: delayedFlowLeg(),
            [TestChainName.test3]: delayedFlowLeg(),
          }),
        ).to.not.throw();
      });
    });
  });

  describe('assertDelayedFlowRoutePreconditions', () => {
    let multiProvider: MultiProvider;

    beforeEach(() => {
      multiProvider = MultiProvider.createTestMultiProvider();
    });

    it('rejects a delayed-flow leg whose mailbox is still at nonce 0', async () => {
      stubMailboxNonce(0);

      const message = await captureError(() =>
        assertDelayedFlowRoutePreconditions({
          multiProvider,
          warpDeployConfig: {
            [TestChainName.test1]: delayedFlowLeg(),
            [TestChainName.test2]: delayedFlowLeg(),
          },
        }),
      );

      expect(message).to.include('nonce 0');
    });

    it('accepts a delayed-flow route whose mailboxes have dispatched before', async () => {
      stubMailboxNonce(1);

      const message = await captureError(() =>
        assertDelayedFlowRoutePreconditions({
          multiProvider,
          warpDeployConfig: {
            [TestChainName.test1]: delayedFlowLeg(),
            [TestChainName.test2]: delayedFlowLeg(),
          },
        }),
      );

      expect(message).to.equal('');
    });

    it('does not read mailbox state for a route without a delayed-flow leg', async () => {
      const connectStub = stubMailboxNonce(0);

      const message = await captureError(() =>
        assertDelayedFlowRoutePreconditions({
          multiProvider,
          warpDeployConfig: {
            [TestChainName.test1]: plainLeg(),
            [TestChainName.test2]: plainLeg(),
          },
        }),
      );

      expect(message).to.equal('');
      expect(connectStub.called).to.be.false;
    });

    it('accepts a remoteIsms that omits a route-derived counterpart', async () => {
      stubMailboxNonce(1);

      const message = await captureError(() =>
        assertDelayedFlowRoutePreconditions({
          multiProvider,
          warpDeployConfig: {
            [TestChainName.test1]: chainConfig({
              interchainSecurityModule: delayedFlowIsm({
                [TestChainName.test2]: remoteIsm(),
              }),
            }),
            [TestChainName.test2]: delayedFlowLeg(),
            [TestChainName.test3]: delayedFlowLeg(),
          },
        }),
      );

      expect(message).to.equal('');
    });

    it('rejects a remoteRouters entry naming a chain the route neither deploys nor enrolls', async () => {
      stubMailboxNonce(1);

      const message = await captureError(() =>
        assertDelayedFlowRoutePreconditions({
          multiProvider,
          warpDeployConfig: {
            [TestChainName.test1]: chainConfig({
              interchainSecurityModule: delayedFlowIsm(),
              remoteRouters: { [TestChainName.test3]: remoteRouter() },
            }),
            [TestChainName.test2]: delayedFlowLeg(),
          },
        }),
      );

      expect(message).to.include(TestChainName.test3);
      expect(message).to.include('remoteRouters');
    });
  });

  describe('executeWarpDeploy', () => {
    let multiProvider: MultiProvider;

    beforeEach(() => {
      multiProvider = MultiProvider.createTestMultiProvider();
    });

    // executeWarpDeploy is an exported SDK entry point, so the preconditions
    // cannot live only in the CLI wrappers: a caller reaching it directly with
    // an unusable topology must not get as far as deploying anything. The stubs
    // cover the first two things it would deploy — the ISM/hook trees and the
    // routers themselves.
    interface Case {
      name: string;
      mailboxNonce: number;
      warpDeployConfig: () => WarpRouteDeployConfigMailboxRequired;
      expectedMessage: string;
    }

    const cases: Case[] = [
      {
        name: 'rejects a partial delayed-flow topology before deploying anything',
        mailboxNonce: 1,
        warpDeployConfig: () => ({
          [TestChainName.test1]: delayedFlowLeg(),
          [TestChainName.test2]: plainLeg(),
        }),
        expectedMessage: TestChainName.test2,
      },
      {
        name: 'rejects a delayed-flow leg on a nonce-0 mailbox before deploying anything',
        mailboxNonce: 0,
        warpDeployConfig: () => ({
          [TestChainName.test1]: delayedFlowLeg(),
          [TestChainName.test2]: delayedFlowLeg(),
        }),
        expectedMessage: 'nonce 0',
      },
    ];

    for (const testCase of cases) {
      it(testCase.name, async () => {
        stubMailboxNonce(testCase.mailboxNonce);
        const ismCreate = sandbox.stub(EvmIsmModule, 'create').rejects();
        const tokenDeploy = sandbox
          .stub(HypERC20Deployer.prototype, 'deploy')
          .rejects();

        const message = await captureError(async () => {
          await executeWarpDeploy(
            testCase.warpDeployConfig(),
            multiProvider,
            {},
            {},
            {},
          );
        });

        expect(message).to.include(testCase.expectedMessage);
        expect(ismCreate.called, 'deployed an ISM tree').to.be.false;
        expect(tokenDeploy.called, 'deployed a router').to.be.false;
      });
    }

    // The extension entry point omits checks that measure the route by this
    // subset; the CLI validates the complete route before reaching it.
    it('executeWarpRouteExtensionDeploy accepts a subset declaring the legs it joins', async () => {
      stubMailboxNonce(1);

      const message = await captureError(async () => {
        await executeWarpRouteExtensionDeploy(
          {
            [TestChainName.test3]: chainConfig({
              interchainSecurityModule: delayedFlowIsm(),
              remoteRouters: {
                [TestChainName.test1]: remoteRouter(),
                [TestChainName.test2]: remoteRouter(),
              },
            }),
          },
          multiProvider,
          {},
          {},
          {},
        );
      });

      // Reached the deployment work itself (which has no registry addresses to
      // work from here) rather than being rejected by the preconditions.
      expect(message).to.include(
        `Registry factory addresses not found for ${TestChainName.test3}`,
      );
    });
  });
});
