import { providers } from 'ethers';

import { Mailbox__factory, ProxyAdmin__factory } from '@hyperlane-xyz/core';
import {
  Address,
  objMap,
  promiseObjAll,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { DEFAULT_CONTRACT_READ_CONCURRENCY } from '../consts/concurrency.js';
import { proxyAdmin } from '../deploy/proxy.js';
import { EvmHookReader } from '../hook/EvmHookReader.js';
import { EvmIcaRouterReader } from '../ica/EvmIcaReader.js';
import { EvmIsmReader } from '../ism/EvmIsmReader.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainNameOrId, DeployedOwnableConfig } from '../types.js';

import { CoreConfig, DerivedCoreConfig } from './types.js';

interface CoreReader {
  deriveCoreConfig(contracts: {
    mailbox: Address;
    interchainAccountRouter: Address;
  }): Promise<CoreConfig>;
}

export class EvmCoreReader implements CoreReader {
  public readonly provider: providers.Provider;
  public readonly evmHookReader: EvmHookReader;
  public readonly evmIsmReader: EvmIsmReader;
  public readonly evmIcaRouterReader: EvmIcaRouterReader;

  protected readonly logger = rootLogger.child({ module: 'EvmCoreReader' });

  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly chain: ChainNameOrId,
    protected readonly concurrency: number = multiProvider.tryGetRpcConcurrency(
      chain,
    ) ?? DEFAULT_CONTRACT_READ_CONCURRENCY,
  ) {
    this.provider = this.multiProvider.getProvider(chain);
    this.evmHookReader = new EvmHookReader(multiProvider, chain, concurrency);
    this.evmIsmReader = new EvmIsmReader(multiProvider, chain, concurrency);
    this.evmIcaRouterReader = new EvmIcaRouterReader(multiProvider, chain);
  }

  /**
   * Derives the core configuration for a given Mailbox address.
   *
   * @param address - The address of the Mailbox contract.
   * @returns A promise that resolves to the CoreConfig object, containing the owner, default ISM, default Hook, and required Hook configurations.
   */
  async deriveCoreConfig({
    mailbox,
    interchainAccountRouter,
  }: {
    mailbox: Address;
    interchainAccountRouter?: Address;
  }): Promise<DerivedCoreConfig> {
    const mailboxInstance = Mailbox__factory.connect(mailbox, this.provider);
    const [defaultIsm, defaultHook, requiredHook, mailboxProxyAdmin] =
      await Promise.all([
        mailboxInstance.defaultIsm(),
        mailboxInstance.defaultHook(),
        mailboxInstance.requiredHook(),
        proxyAdmin(this.provider, mailboxInstance.address),
      ]);

    // Parallelize each configuration request
    const results = await promiseObjAll(
      objMap(
        {
          owner: mailboxInstance.owner(),
          defaultIsm: this.evmIsmReader.deriveIsmConfig(defaultIsm),
          defaultHook: this.evmHookReader.deriveHookConfig(defaultHook),
          requiredHook: this.evmHookReader.deriveHookConfig(requiredHook),
          interchainAccountRouter: interchainAccountRouter
            ? this.evmIcaRouterReader.deriveConfig(interchainAccountRouter)
            : undefined,
          proxyAdmin: this.getProxyAdminConfig(mailboxProxyAdmin),
        },
        async (_, readerCall) => {
          try {
            return readerCall;
          } catch (e) {
            this.logger.error(
              `EvmCoreReader: readerCall failed for ${mailbox}:`,
              e,
            );
            return;
          }
        },
      ),
    );

    return results as DerivedCoreConfig;
  }

  private async getProxyAdminConfig(
    proxyAdminAddress: Address,
  ): Promise<DeployedOwnableConfig> {
    const instance = ProxyAdmin__factory.connect(
      proxyAdminAddress,
      this.provider,
    );

    const owner = await instance.owner();
    return {
      owner,
      address: proxyAdminAddress,
    };
  }
}
