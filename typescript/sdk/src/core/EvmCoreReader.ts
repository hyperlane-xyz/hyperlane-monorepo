import { providers } from 'ethers';

import { Mailbox__factory, ProxyAdmin__factory } from '@hyperlane-xyz/core';
import { Address, assert, rootLogger } from '@hyperlane-xyz/utils';

import { DEFAULT_CONTRACT_READ_CONCURRENCY } from '../consts/concurrency.js';
import { proxyAdmin } from '../deploy/proxy.js';
import { EvmHookReader } from '../hook/EvmHookReader.js';
import { hookTreeContainsLegacyIgp } from '../hook/utils.js';
import { EvmIcaRouterReader } from '../ica/EvmIcaReader.js';
import { EvmIsmReader } from '../ism/EvmIsmReader.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainNameOrId, DeployedOwnableConfig } from '../types.js';
import { fetchPackageVersion } from '../utils/contract.js';

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

    const readConfig = async <T>(
      readerCall: Promise<T> | undefined,
    ): Promise<T | undefined> => {
      try {
        return await readerCall;
      } catch (e) {
        this.logger.error(
          `EvmCoreReader: readerCall failed for ${mailbox}:`,
          e,
        );
        return;
      }
    };

    // Parallelize each configuration request
    const [
      owner,
      derivedDefaultIsm,
      derivedDefaultHook,
      derivedRequiredHook,
      derivedIcaRouterConfig,
      proxyAdminConfig,
      contractVersion,
    ] = await Promise.all([
      readConfig(mailboxInstance.owner()),
      readConfig(this.evmIsmReader.deriveIsmConfig(defaultIsm)),
      readConfig(this.evmHookReader.deriveHookConfig(defaultHook)),
      readConfig(this.evmHookReader.deriveHookConfig(requiredHook)),
      readConfig(
        interchainAccountRouter
          ? this.evmIcaRouterReader.deriveConfig(interchainAccountRouter)
          : undefined,
      ),
      readConfig(this.getProxyAdminConfig(mailboxProxyAdmin)),
      fetchPackageVersion(this.provider, mailbox, this.logger),
    ]);

    assert(owner, `EvmCoreReader: owner read failed for ${mailbox}`);
    assert(
      derivedDefaultIsm,
      `EvmCoreReader: defaultIsm read failed for ${mailbox}`,
    );
    assert(
      derivedDefaultHook,
      `EvmCoreReader: defaultHook read failed for ${mailbox}`,
    );
    assert(
      derivedRequiredHook,
      `EvmCoreReader: requiredHook read failed for ${mailbox}`,
    );

    const derivedConfig: DerivedCoreConfig = {
      owner,
      defaultIsm: derivedDefaultIsm,
      defaultHook: derivedDefaultHook,
      requiredHook: derivedRequiredHook,
      interchainAccountRouter: derivedIcaRouterConfig,
      proxyAdmin: proxyAdminConfig,
      contractVersion,
    };
    const hasLegacyIgp =
      hookTreeContainsLegacyIgp(derivedConfig.defaultHook) ||
      hookTreeContainsLegacyIgp(derivedConfig.requiredHook);

    return {
      ...derivedConfig,
      ...(hasLegacyIgp ? { deployQuotedCalls: false } : {}),
    };
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
