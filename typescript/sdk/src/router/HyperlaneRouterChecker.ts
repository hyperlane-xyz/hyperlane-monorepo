import { ethers } from 'ethers';

import {
  addressToBytes32,
  assert,
  eqAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { HyperlaneFactories } from '../contracts/types.js';
import { HyperlaneAppChecker } from '../deploy/HyperlaneAppChecker.js';
import { DerivedIsmConfig, EvmIsmReader } from '../ism/EvmIsmReader.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { moduleMatchesConfig } from '../ism/utils.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainMap, ChainName } from '../types.js';

import { RouterApp } from './RouterApps.js';
import {
  ClientViolation,
  ClientViolationType,
  RouterConfig,
  RouterViolation,
  RouterViolationType,
} from './types.js';

export class HyperlaneRouterChecker<
  Factories extends HyperlaneFactories,
  App extends RouterApp<Factories>,
  Config extends RouterConfig,
> extends HyperlaneAppChecker<App, Config> {
  constructor(
    multiProvider: MultiProvider,
    app: App,
    configMap: ChainMap<Config>,
    readonly ismFactory?: HyperlaneIsmFactory,
    readonly logger = rootLogger.child({ module: 'HyperlaneRouterChecker' }),
  ) {
    super(multiProvider, app, configMap);
  }

  async checkChain(chain: ChainName): Promise<void> {
    await this.checkMailboxClient(chain);
    await this.checkEnrolledRouters(chain);
    await super.checkOwnership(
      chain,
      this.configMap[chain].owner,
      this.configMap[chain].ownerOverrides,
    );
  }

  async checkMailboxClient(chain: ChainName): Promise<void> {
    const router = this.app.router(this.app.getContracts(chain));

    const config = this.configMap[chain];

    const mailboxAddr = await router.mailbox();
    if (!eqAddress(mailboxAddr, config.mailbox)) {
      this.addViolation({
        chain,
        type: ClientViolationType.Mailbox,
        contract: router,
        actual: mailboxAddr,
        expected: config.mailbox,
      });
    }

    if (config.hook) {
      assert(
        typeof config.hook === 'string',
        'Hook objects not supported in router checker',
      );
      const hook = await router.hook();
      if (!eqAddress(hook, config.hook as string)) {
        this.addViolation({
          chain,
          type: ClientViolationType.Hook,
          contract: router,
          actual: hook,
          expected: config.hook,
        });
      }
    }

    const actualIsmAddress = await router.interchainSecurityModule();

    const matches = await moduleMatchesConfig(
      chain,
      actualIsmAddress,
      config.interchainSecurityModule ?? ethers.constants.AddressZero,
      this.multiProvider,
      this.ismFactory?.chainMap[chain] ?? ({} as any),
      mailboxAddr,
    );

    if (!matches) {
      const ismReader = new EvmIsmReader(this.multiProvider, chain);
      let actualConfig: string | DerivedIsmConfig =
        ethers.constants.AddressZero;
      if (actualIsmAddress !== ethers.constants.AddressZero) {
        actualConfig = await ismReader.deriveIsmConfig(actualIsmAddress);
      }

      let expectedConfig = config.interchainSecurityModule;

      if (typeof expectedConfig === 'string') {
        expectedConfig = await ismReader.deriveIsmConfig(expectedConfig);
      }

      if (expectedConfig === undefined) {
        expectedConfig = ethers.constants.AddressZero;
      }

      const violation: ClientViolation = {
        chain,
        type: ClientViolationType.InterchainSecurityModule,
        contract: router,
        actual: actualConfig,
        expected: expectedConfig,
        description: `ISM config does not match deployed ISM`,
      };
      this.addViolation(violation);
    }
  }

  async checkEnrolledRouters(chain: ChainName): Promise<void> {
    const router = this.app.router(this.app.getContracts(chain));
    const allRemoteChains = Object.keys(this.configMap);
    const currentRouters: ChainMap<string> = {};
    const expectedRouters: ChainMap<string> = {};
    const routerDiff: ChainMap<string> = {};

    await Promise.all(
      allRemoteChains.map(async (remoteChain) => {
        if (remoteChain === chain) {
          return;
        }

        const remoteRouterAddress = this.app.routerAddress(remoteChain);
        const remoteDomainId = this.multiProvider.getDomainId(remoteChain);
        const actualRouter = await router.routers(remoteDomainId);
        const expectedRouter = addressToBytes32(remoteRouterAddress);

        currentRouters[remoteChain] = actualRouter;
        expectedRouters[remoteChain] = expectedRouter;

        if (actualRouter !== expectedRouter) {
          routerDiff[remoteChain] = expectedRouter;
        }
      }),
    );

    if (Object.keys(routerDiff).length > 0) {
      const violation: RouterViolation = {
        chain,
        type: RouterViolationType.EnrolledRouter,
        contract: router,
        actual: currentRouters,
        expected: expectedRouters,
        routerDiff,
        description: `Routers for some domains are missing or not enrolled correctly`,
      };
      this.addViolation(violation);
    }
  }
}
