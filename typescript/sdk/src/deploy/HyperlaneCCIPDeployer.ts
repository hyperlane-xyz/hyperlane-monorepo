import { CCIPHook__factory, CCIPIsm__factory } from '@hyperlane-xyz/core';
import {
  Address,
  ZERO_ADDRESS_HEX_32,
  addressToBytes32,
  assert,
  rootLogger,
} from '@hyperlane-xyz/utils';

import {
  HyperlaneAddressesMap,
  HyperlaneContracts,
} from '../contracts/types.js';
import { CoreAddresses } from '../core/contracts.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainMap, ChainName } from '../types.js';
import {
  CCIPContractCache,
  getCCIPChainSelector,
  getCCIPRouterAddress,
} from '../utils/ccip.js';

import { HyperlaneDeployer } from './HyperlaneDeployer.js';
import { ContractVerifier } from './verify/ContractVerifier.js';

export class HyperlaneCCIPDeployer extends HyperlaneDeployer<
  Set<ChainName>,
  {}
> {
  private ccipContractCache: CCIPContractCache = new CCIPContractCache();

  constructor(
    multiProvider: MultiProvider,
    readonly core: ChainMap<Partial<CoreAddresses>>,
    contractVerifier?: ContractVerifier,
  ) {
    super(
      multiProvider,
      {},
      {
        logger: rootLogger.child({ module: 'HyperlaneCCIPDeployer' }),
        contractVerifier,
      },
    );
  }

  cacheAddressesMap(addressesMap: HyperlaneAddressesMap<any>): void {
    super.cacheAddressesMap(addressesMap);
    this.ccipContractCache.cacheAddressesMap(addressesMap);
  }

  async deployContracts(
    origin: ChainName,
    config: Set<ChainName>,
  ): Promise<HyperlaneContracts<{}>> {
    // Deploy ISMs from chain to eachdestination chain concurrently
    await Promise.all(
      Array.from(config).map(async (destination) => {
        // Deploy CCIP ISM for this origin->destination pair
        await this.deployCCIPIsm(origin, destination);
      }),
    );

    //On the origin chain, deploy hooks for each destination chain in series
    for (const destination of config) {
      // Grab the ISM from the cache
      const ccipIsmAddress = this.ccipContractCache.getIsm(origin, destination);
      assert(
        ccipIsmAddress,
        `CCIP ISM not found for ${origin} -> ${destination}`,
      );

      await this.deployCCIPHook(origin, destination, ccipIsmAddress);
    }

    // Authorize hooks for each destination chain concurrently
    await Promise.all(
      Array.from(config).map(async (destination) => {
        const ccipIsmAddress = this.ccipContractCache.getIsm(
          origin,
          destination,
        );
        assert(
          ccipIsmAddress,
          `CCIP ISM not found for ${origin} -> ${destination}`,
        );

        const ccipHookAddress = this.ccipContractCache.getHook(
          origin,
          destination,
        );
        assert(
          ccipHookAddress,
          `CCIP Hook not found for ${origin} -> ${destination}`,
        );

        await this.authorizeHook(destination, ccipIsmAddress, ccipHookAddress);
      }),
    );

    this.ccipContractCache.writeBack(this.cachedAddresses);
    return {};
  }

  private async authorizeHook(
    destination: ChainName,
    ccipIsmAddress: Address,
    ccipHookAddress: Address,
  ) {
    const bytes32HookAddress = addressToBytes32(ccipHookAddress);
    const ccipIsm = CCIPIsm__factory.connect(
      ccipIsmAddress,
      this.multiProvider.getSigner(destination),
    );

    const authorizedHook = await ccipIsm.authorizedHook();
    this.logger.debug(
      'Authorized hook on ism %s: %s',
      ccipIsm.address,
      authorizedHook,
    );

    // If the hook is already set, return
    if (authorizedHook === bytes32HookAddress) {
      this.logger.info(
        'Authorized hook already set on ism %s',
        ccipIsm.address,
      );
      return;
    }

    // If not already set, must not be initialised yet
    if (authorizedHook !== ZERO_ADDRESS_HEX_32) {
      this.logger.error(
        'Authorized hook mismatch on ism %s, expected %s, got %s',
        ccipIsm.address,
        bytes32HookAddress,
        authorizedHook,
      );
      throw new Error('Authorized hook mismatch');
    }

    // If not initialised, set the hook
    this.logger.info(
      'Setting authorized hook %s on ism %s on destination %s',
      ccipHookAddress,
      ccipIsm.address,
      destination,
    );
    await this.multiProvider.handleTx(
      destination,
      ccipIsm.setAuthorizedHook(
        bytes32HookAddress,
        this.multiProvider.getTransactionOverrides(destination),
      ),
    );
  }

  protected async deployCCIPIsm(
    origin: ChainName,
    destination: ChainName,
  ): Promise<void> {
    const cachedIsm = this.ccipContractCache.getIsm(origin, destination);
    if (cachedIsm) {
      this.logger.debug(
        'CCIP ISM already deployed for %s -> %s: %s',
        origin,
        destination,
        cachedIsm,
      );
      return;
    }

    const ccipOriginChainSelector = getCCIPChainSelector(origin);
    const ccipIsmChainRouterAddress = getCCIPRouterAddress(destination);
    assert(
      ccipOriginChainSelector,
      `CCIP chain selector not found for ${origin}`,
    );
    assert(
      ccipIsmChainRouterAddress,
      `CCIP router address not found for ${origin}`,
    );

    const ccipIsm = await this.deployContractFromFactory(
      destination,
      new CCIPIsm__factory(),
      'CCIPIsm',
      [ccipIsmChainRouterAddress, ccipOriginChainSelector],
      undefined,
      false,
    );

    this.ccipContractCache.setIsm(origin, destination, ccipIsm);
  }

  protected async deployCCIPHook(
    origin: ChainName,
    destination: ChainName,
    ccipIsmAddress: Address,
  ): Promise<void> {
    const cachedHook = this.ccipContractCache.getHook(origin, destination);
    if (cachedHook) {
      this.logger.debug(
        'CCIP Hook already deployed for %s -> %s: %s',
        origin,
        destination,
        cachedHook,
      );
      return;
    }

    const mailbox = this.core[origin].mailbox;
    assert(mailbox, `Mailbox address is required for ${origin}`);

    const ccipDestinationChainSelector = getCCIPChainSelector(destination);
    const ccipOriginChainRouterAddress = getCCIPRouterAddress(origin);
    assert(
      ccipDestinationChainSelector,
      `CCIP chain selector not found for ${destination}`,
    );
    assert(
      ccipOriginChainRouterAddress,
      `CCIP router address not found for ${destination}`,
    );

    const destinationDomain = this.multiProvider.getDomainId(destination);

    const ccipHook = await this.deployContractFromFactory(
      origin,
      new CCIPHook__factory(),
      'CCIPHook',
      [
        ccipOriginChainRouterAddress,
        ccipDestinationChainSelector,
        mailbox,
        destinationDomain,
        addressToBytes32(ccipIsmAddress),
      ],
      undefined,
      false,
    );

    this.ccipContractCache.setHook(origin, destination, ccipHook);
  }
}
