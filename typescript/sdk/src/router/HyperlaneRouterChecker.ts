import { ethers } from 'ethers';
import { zeroAddress } from 'viem';

import { IMailbox__factory } from '@hyperlane-xyz/core';
import { addressToBytes32, eqAddress } from '@hyperlane-xyz/utils';

import { HyperlaneFactories } from '../contracts/types.js';
import { HyperlaneAppChecker } from '../deploy/HyperlaneAppChecker.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { moduleMatchesConfig } from '../ism/utils.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainMap, ChainName } from '../types.js';

import { RouterApp } from './RouterApps.js';
import {
  ClientViolation,
  ClientViolationType,
  MailboxClientConfig,
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
  ) {
    super(multiProvider, app, configMap);
  }

  async checkChain(chain: ChainName): Promise<void> {
    await this.checkMailboxClient(chain);
    await this.checkEnrolledRouters(chain);
    await super.checkOwnership(chain, this.configMap[chain].owner);
  }

  async checkMailboxClient(chain: ChainName): Promise<void> {
    const router = this.app.router(this.app.getContracts(chain));

    const checkMailboxClientProperty = async (
      property: keyof MailboxClientConfig,
      actual: string,
      violationType: ClientViolationType,
    ) => {
      const value = this.configMap[chain][property];

      // If the value is an object, it's an ISM config
      // and we should make sure it matches the actual ISM config
      if (value && typeof value === 'object') {
        if (!this.ismFactory) {
          throw Error(
            'ISM factory not provided to HyperlaneRouterChecker, cannot check object-based ISM config',
          );
        }

        const matches = await moduleMatchesConfig(
          chain,
          actual,
          value,
          this.multiProvider,
          this.ismFactory!.chainMap[chain],
        );

        if (!matches) {
          const violation: ClientViolation = {
            chain,
            type: violationType,
            contract: router,
            actual,
            expected: value,
            description: `ISM config does not match deployed ISM`,
          };
          this.addViolation(violation);
        }
        return;
      }
      const expected =
        value && typeof value === 'string'
          ? value
          : ethers.constants.AddressZero;
      if (!eqAddress(actual, expected)) {
        const violation: ClientViolation = {
          chain,
          type: violationType,
          contract: router,
          actual,
          expected,
        };
        this.addViolation(violation);
      }
    };

    const mailboxAddr = await router.mailbox();
    await checkMailboxClientProperty(
      'mailbox',
      mailboxAddr,
      ClientViolationType.Mailbox,
    );
    await checkMailboxClientProperty(
      'hook',
      await router.hook(),
      ClientViolationType.Hook,
    );

    const mailbox = IMailbox__factory.connect(
      mailboxAddr,
      this.multiProvider.getProvider(chain),
    );
    const ism = await mailbox.recipientIsm(router.address);

    if (
      !this.configMap[chain].interchainSecurityModule ||
      this.configMap[chain].interchainSecurityModule === zeroAddress
    ) {
      const defaultIsm = await mailbox.defaultIsm();
      if (!eqAddress(defaultIsm, ism)) {
        this.addViolation({
          chain,
          type: ClientViolationType.InterchainSecurityModule,
          contract: router,
          actual: ism,
          expected: zeroAddress,
        });
      }
    } else {
      await checkMailboxClientProperty(
        'interchainSecurityModule',
        ism,
        ClientViolationType.InterchainSecurityModule,
      );
    }
  }

  async checkEnrolledRouters(chain: ChainName): Promise<void> {
    const router = this.app.router(this.app.getContracts(chain));
    const remoteChains = await this.app.remoteChains(chain);
    await Promise.all(
      remoteChains.map(async (remoteChain) => {
        const remoteRouterAddress = this.app.routerAddress(remoteChain);
        const remoteDomainId = this.multiProvider.getDomainId(remoteChain);
        const actualRouter = await router.routers(remoteDomainId);
        const expectedRouter = addressToBytes32(remoteRouterAddress);
        if (actualRouter !== expectedRouter) {
          const violation: RouterViolation = {
            chain,
            remoteChain,
            type: RouterViolationType.EnrolledRouter,
            contract: router,
            actual: actualRouter,
            expected: expectedRouter,
          };
          this.addViolation(violation);
        }
      }),
    );
  }
}
