import { ethers } from 'ethers';

import { Router } from '@hyperlane-xyz/core';
import {
  AddressBytes32,
  addressToBytes32,
  eqAddress,
  isZeroishAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { HyperlaneFactories } from '../contracts/types.js';
import { HyperlaneAppChecker } from '../deploy/HyperlaneAppChecker.js';
import { EvmIsmReader } from '../ism/EvmIsmReader.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { DerivedIsmConfig } from '../ism/types.js';
import { moduleMatchesConfig } from '../ism/utils.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainMap, ChainName } from '../types.js';

import { RouterApp } from './RouterApps.js';
import {
  ClientViolation,
  ClientViolationType,
  MissingEnrolledRouterViolation,
  MissingRouterViolation,
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

  protected async checkMailbox(
    chain: ChainName,
    router: Router,
    config: RouterConfig,
  ): Promise<void> {
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

    if (config.hook && typeof config.hook === 'string') {
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
  }

  protected async checkMailboxIsm(
    chain: ChainName,
    router: Router,
    config: RouterConfig,
  ): Promise<void> {
    const mailboxAddr = await router.mailbox();
    const actualIsmAddress = await router.interchainSecurityModule();

    // If the router is its own ism (e.g. the ICA router, skip checking configs)
    if (eqAddress(actualIsmAddress, router.address)) return;
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
      if (!isZeroishAddress(actualIsmAddress)) {
        actualConfig = await ismReader.deriveIsmConfig(actualIsmAddress);
      }

      let expectedConfig = config.interchainSecurityModule;

      if (
        typeof expectedConfig === 'string' &&
        !isZeroishAddress(expectedConfig)
      ) {
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

  async checkMailboxClient(chain: ChainName): Promise<void> {
    const router = this.app.router(this.app.getContracts(chain));
    const config = this.configMap[chain];
    await this.checkMailbox(chain, router, config);
    await this.checkMailboxIsm(chain, router, config);
  }

  async checkEnrolledRouters(
    chain: ChainName,
    expectedRemoteChains: ChainName[] = [],
  ): Promise<void> {
    const router = this.app.router(this.app.getContracts(chain));
    const actualRemoteChains = await this.app.remoteChains(chain);

    const currentRouters: ChainMap<string> = {};
    const expectedRouters: ChainMap<string> = {};

    const missingRemoteChains = expectedRemoteChains
      .filter((chn) => !actualRemoteChains.includes(chn))
      .sort();
    const misconfiguredRouterDiff: ChainMap<{
      actual: AddressBytes32;
      expected: AddressBytes32;
    }> = {};
    const missingRouterDomains: ChainName[] = [];

    await Promise.all(
      actualRemoteChains.map(async (remoteChain) => {
        let remoteRouterAddress: string;
        try {
          remoteRouterAddress = this.app.routerAddress(remoteChain);
        } catch {
          // failed to read remote router address from the config
          missingRouterDomains.push(remoteChain);
          return;
        }
        const remoteDomainId = this.multiProvider.getDomainId(remoteChain);
        const actualRouter = await router.routers(remoteDomainId);
        const expectedRouter = addressToBytes32(remoteRouterAddress);

        currentRouters[remoteChain] = actualRouter;
        expectedRouters[remoteChain] = expectedRouter;

        if (actualRouter !== expectedRouter) {
          misconfiguredRouterDiff[remoteChain] = {
            actual: actualRouter,
            expected: expectedRouter,
          };
        }
      }),
    );

    const expectedRouterChains = actualRemoteChains.filter(
      (chain) => !missingRouterDomains.includes(chain),
    );

    if (missingRemoteChains.length > 0) {
      const violation: MissingEnrolledRouterViolation = {
        chain,
        type: RouterViolationType.MissingEnrolledRouter,
        contract: router,
        actual: actualRemoteChains.join(', '),
        expected: expectedRemoteChains.join(),
        missingChains: missingRemoteChains,
        description: `Routers for some domains are missing from the router`,
      };
      this.addViolation(violation);
    }

    if (Object.keys(misconfiguredRouterDiff).length > 0) {
      const violation: RouterViolation = {
        chain,
        type: RouterViolationType.MisconfiguredEnrolledRouter,
        contract: router,
        actual: currentRouters,
        expected: expectedRouters,
        routerDiff: misconfiguredRouterDiff,
        description: `Routers for some domains are missing or not enrolled correctly`,
      };
      this.addViolation(violation);
    }

    if (missingRouterDomains.length > 0) {
      const violation: MissingRouterViolation = {
        chain,
        type: RouterViolationType.MissingRouter,
        contract: router,
        actual: actualRemoteChains.join(','),
        expected: expectedRouterChains.join(','),
        description: `Routers for some domains are missing from the config`,
      };
      this.addViolation(violation);
    }
  }
}
