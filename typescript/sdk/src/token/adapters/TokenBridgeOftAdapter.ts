import { ethers } from 'ethers';
import { Address } from '@hyperlane-xyz/utils';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ChainName } from '../../types.js';
import { TokenMetadata } from '../types.js';
import { EvmHypCollateralAdapter, EvmTokenAdapter } from './EvmTokenAdapter.js';

/**
 * Adapter for OFT token bridge integration with Hyperlane.
 * 
 * This adapter works with TokenBridgeOft which:
 * - Extends HypERC20Collateral to hold OFT tokens as collateral
 * - Uses LayerZero for all cross-chain transfers (user and rebalancing)
 * - Acts as its own bridge for rebalancing (following CCTP pattern)
 * 
 * The rebalancer uses the standard MovableCollateralRouter.rebalance() function,
 * passing the TokenBridgeOft address as the bridge (router acts as its own bridge).
 */
export class TokenBridgeOftAdapter extends EvmHypCollateralAdapter {
  
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { token: Address },
    public readonly oftTokenAddress: Address,
  ) {
    super(chainName, multiProvider, addresses);
  }

  /**
   * Gets the balance of the OFT token held by the TokenBridgeOft router.
   * This represents the collateral available for bridging.
   */
  override async getBridgedSupply(): Promise<bigint | undefined> {
    // Query the balance of the OFT token held by the router
    const oftTokenContract = new ethers.Contract(
      this.oftTokenAddress,
      ['function balanceOf(address owner) view returns (uint256)'],
      this.getProvider(),
    );

    try {
      const balance = await oftTokenContract.balanceOf(this.addresses.token);
      return BigInt(balance.toString());
    } catch (error) {
      // Failed to get OFT balance
      return undefined;
    }
  }

  /**
   * Gets metadata from the underlying OFT token
   */
  override async getMetadata(isNft?: boolean): Promise<TokenMetadata> {
    const oftAdapter = new EvmTokenAdapter(this.chainName, this.multiProvider, {
      token: this.oftTokenAddress,
    });
    return oftAdapter.getMetadata(isNft);
  }

  /**
   * Check if an address is an allowed rebalancer on the router
   */
  override async isRebalancer(address: Address): Promise<boolean> {
    // Use the standard MovableCollateralRouter allowedRebalancers check
    try {
      const allowedRebalancers = await this.collateralContract.allowedRebalancers();
      return allowedRebalancers.map((r: string) => r.toLowerCase()).includes(address.toLowerCase());
    } catch {
      return false;
    }
  }

  /**
   * Check if a bridge is allowed for a domain.
   * For OFT, the router itself acts as the bridge (following CCTP pattern).
   */
  override async isBridgeAllowed(domain: number, bridge: Address): Promise<boolean> {
    // Use the standard MovableCollateralRouter allowedBridges check
    try {
      const allowedBridges = await this.collateralContract.allowedBridges(domain);
      return allowedBridges.map((b: string) => b.toLowerCase()).includes(bridge.toLowerCase());
    } catch {
      return false;
    }
  }

  /**
   * Get quotes for rebalancing.
   * Since TokenBridgeOft acts as its own bridge, we query the router directly.
   */
  override async getRebalanceQuotes(
    bridge: string,
    domain: number,
    recipient: string,
    amount: string | number | bigint,
    _isWarp: boolean,
  ): Promise<any[]> {
    // Query the router's quoteTransferRemote for LayerZero fees
    const routerContract = new ethers.Contract(
      this.addresses.token,
      [
        'function quoteTransferRemote(uint32 destination, bytes32 recipient, uint256 amount) view returns (tuple(address token, uint256 amount)[])',
      ],
      this.getProvider(),
    );

    try {
      const recipientBytes32 = ethers.utils.hexZeroPad(recipient, 32);
      const quotes = await routerContract.quoteTransferRemote(
        domain,
        recipientBytes32,
        amount.toString(),
      );
      return quotes;
    } catch (error) {
      console.warn('Failed to get router quotes:', error);
      // Return default quote if query fails
      return [
        { token: ethers.constants.AddressZero, amount: ethers.utils.parseEther('0.01') },
        { token: this.oftTokenAddress, amount: amount },
      ];
    }
  }

}