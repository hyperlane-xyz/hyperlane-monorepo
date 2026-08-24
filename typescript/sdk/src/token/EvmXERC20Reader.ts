import { ethers } from 'ethers';

import { Ownable__factory, ProxyAdmin__factory } from '@hyperlane-xyz/core';
import {
  Address,
  eqAddress,
  normalizeAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { proxyAdmin } from '../deploy/proxy.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { EvmEventLogsReader } from '../rpc/evm/EvmEventLogsReader.js';
import { viemLogFromGetEventLogsResponse } from '../rpc/evm/utils.js';
import { ChainNameOrId } from '../types.js';
import { HyperlaneReader } from '../utils/HyperlaneReader.js';

import { XERC20Type } from './types.js';
import { CONFIGURATION_CHANGED_EVENT_SELECTOR } from './xerc20-abi.js';
import { XERC20LimitsMap, readXERC20Limits } from './xerc20-limits.js';
import {
  XERC20_LOG_SCAN_BLOCK_RANGE,
  deriveXERC20TokenType,
  latestConfigurationPerBridge,
} from './xerc20.js';

export type {
  StandardXERC20Limits,
  VeloXERC20Limits,
  XERC20Limits,
  XERC20LimitsMap,
} from './xerc20-limits.js';
export { limitsAreZero, limitsMatch } from './xerc20-limits.js';

/**
 * Reader for on-chain XERC20 state.
 * Reads limits and bridge configurations from XERC20 contracts.
 */
export class EvmXERC20Reader extends HyperlaneReader {
  protected logger = rootLogger.child({ module: 'EvmXERC20Reader' });
  protected readonly multiProtocolProvider: MultiProtocolProvider;

  constructor(
    protected readonly multiProvider: MultiProvider,
    chain: ChainNameOrId,
  ) {
    super(multiProvider, chain);
    this.multiProtocolProvider =
      MultiProtocolProvider.fromMultiProvider(multiProvider);
  }

  async deriveXERC20TokenType(xERC20Address: Address): Promise<XERC20Type> {
    return deriveXERC20TokenType(this.multiProvider, this.chain, xERC20Address);
  }

  /**
   * Read current limits for the specified bridges.
   */
  async readLimits(
    xERC20Address: Address,
    bridges: Address[],
    type: XERC20Type,
  ): Promise<XERC20LimitsMap> {
    return readXERC20Limits({
      multiProtocolProvider: this.multiProtocolProvider,
      chain: this.multiProvider.getChainName(this.chain),
      xERC20Address,
      bridges,
      type,
    });
  }

  /**
   * Read all bridges configured on-chain for a Velodrome XERC20 by parsing ConfigurationChanged events.
   * The scan covers the token's whole history, from the block it was deployed in
   * to the chain head, over the block explorer where the chain has a usable one
   * and over the paginated RPC otherwise.
   *
   * Returns an empty array for Standard XERC20, whose bridges this does not
   * enumerate. They are enumerable: a Standard token announces them through
   * BridgeLimitsSet, which getExtraLockBoxConfigs reads. Callers relying on
   * this therefore fall back to the bridges their config names for a Standard
   * token, which is why bringing the two paths together is worth doing.
   */
  async readOnChainBridges(
    xERC20Address: Address,
    type: XERC20Type,
  ): Promise<Address[]> {
    if (type === XERC20Type.Standard) {
      this.logger.debug(
        'Standard XERC20 bridge enumeration is not implemented here',
      );
      return [];
    }

    const logsReader = EvmEventLogsReader.fromConfig(
      { chain: this.chain, paginationBlockRange: XERC20_LOG_SCAN_BLOCK_RANGE },
      this.multiProvider,
      this.logger,
    );

    const rawLogs = await logsReader.getLogsByTopic({
      contractAddress: xERC20Address,
      eventTopic: CONFIGURATION_CHANGED_EVENT_SELECTOR,
    });

    const bridgeToLatestLog = latestConfigurationPerBridge(
      rawLogs.map(viemLogFromGetEventLogsResponse),
    );

    // Filter to active bridges (non-zero limits)
    const activeBridges: Address[] = [];
    for (const [bridge, log] of bridgeToLatestLog) {
      const hasNonZeroLimits =
        log.args.bufferCap !== 0n || log.args.rateLimitPerSecond !== 0n;
      if (hasNonZeroLimits) {
        activeBridges.push(bridge);
      }
    }

    return activeBridges;
  }

  /**
   * Read the owner of the XERC20 token contract.
   * This owner controls limit/bridge management (setBufferCap, addBridge, etc.).
   * Returns undefined if the XERC20 does not expose `owner()` (e.g. a
   * third-party token using AccessControl instead of Ownable) so callers on the
   * warp read/apply path don't break on non-Ownable tokens.
   */
  async readOwner(xERC20Address: Address): Promise<Address | undefined> {
    try {
      const owner = await Ownable__factory.connect(
        xERC20Address,
        this.provider,
      ).owner();
      return normalizeAddress(owner);
    } catch (error) {
      this.logger.debug(
        { xERC20Address, error },
        'XERC20 does not expose owner(); treating owner as undefined',
      );
      return undefined;
    }
  }

  /**
   * Read the ProxyAdmin for the XERC20 proxy and its owner.
   * The ProxyAdmin owner controls upgrades. Returns undefined if the XERC20 is
   * not behind a transparent proxy.
   */
  async readProxyAdmin(
    xERC20Address: Address,
  ): Promise<{ address: Address; owner: Address } | undefined> {
    const proxyAdminAddress = await proxyAdmin(this.provider, xERC20Address);
    if (eqAddress(proxyAdminAddress, ethers.constants.AddressZero)) {
      return undefined;
    }

    const owner = await ProxyAdmin__factory.connect(
      proxyAdminAddress,
      this.provider,
    ).owner();

    return {
      address: normalizeAddress(proxyAdminAddress),
      owner: normalizeAddress(owner),
    };
  }
}
