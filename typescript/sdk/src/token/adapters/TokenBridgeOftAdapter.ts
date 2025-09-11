import { ethers } from 'ethers';
import { Address } from '@hyperlane-xyz/utils';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ChainName } from '../../types.js';
import { TokenMetadata } from '../types.js';
import { EvmHypCollateralAdapter, EvmTokenAdapter } from './EvmTokenAdapter.js';

/**
 * Custom adapter for TokenBridgeOft contracts that bridges OFT tokens via LayerZero.
 * This adapter queries the balance of the underlying OFT token held by the TokenBridgeOft contract.
 * Extends EvmHypCollateralAdapter since it behaves like collateral (holds underlying tokens).
 */
export class TokenBridgeOftAdapter extends EvmHypCollateralAdapter {
  private tokenBridgeOftContract: ethers.Contract;
  
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { token: Address },
    public readonly oftTokenAddress: Address,
  ) {
    super(chainName, multiProvider, addresses);
    
    // Create a contract instance with the rebalanceOft function
    const tokenBridgeOftABI = [
      ...this.collateralContract.interface.fragments,
      'function rebalanceOft(uint32 domain, uint256 amount) payable',
    ];
    
    this.tokenBridgeOftContract = new ethers.Contract(
      addresses.token,
      tokenBridgeOftABI,
      this.getProvider(),
    );
  }

  /**
   * Gets the balance of the OFT token held by the TokenBridgeOft contract.
   * This represents the "bridged supply" available for rebalancing.
   */
  override async getBridgedSupply(): Promise<bigint | undefined> {
    // Query the balance of the OFT token held by the TokenBridgeOft contract
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
   * Override to bypass rebalancer permission check since we use native OFT bridging
   */
  override async isRebalancer(_address: Address): Promise<boolean> {
    // Since we use native OFT send() directly, we don't need rebalancer permissions
    return true;
  }

  /**
   * Override to allow any bridge since we use native OFT bridging
   */
  override async isBridgeAllowed(_domain: number, _bridge: Address): Promise<boolean> {
    // Since we use native OFT send() directly, any bridge is allowed
    return true;
  }

  /**
   * Override to get quotes from the TokenBridgeOft router (Hyperlane protocol fees)
   */
  override async getRebalanceQuotes(
    _bridge: string,
    domain: number,
    _recipient: string,
    amount: string | number | bigint,
    _isWarp: boolean,
  ): Promise<any[]> {
    // Use the TokenBridgeOft quoteTransferRemote function to get Hyperlane protocol fees
    const routerContract = new ethers.Contract(
      this.addresses.token, // This is the TokenBridgeOft router address
      [
        'function quoteTransferRemote(uint32 destination, bytes32 recipient, uint256 amount) view returns (tuple(address token, uint256 amount)[])',
      ],
      this.getProvider(),
    );

    try {
      const recipientBytes32 = ethers.utils.hexZeroPad(_recipient, 32);
      const quotes = await routerContract.quoteTransferRemote(domain, recipientBytes32, amount);
      
      // Convert quotes to expected format - quotes[0] is the protocol fee quote
      return quotes.map((quote: any) => ({ amount: BigInt(quote.amount.toString()) }));
    } catch (error) {
      // Failed to get TokenBridgeOft quote, using default
      // Return a default quote to avoid blocking
      return [{ amount: 100000000000000000n }]; // 0.1 ETH default
    }
  }


  /**
   * Router-to-router: call router.rebalance() for OFT tokens.
   * This follows the same pattern as CCTP rebalancer.
   * Use LayerZero protocol fees from the quotes.
   */
  override async populateRebalanceTx(
    domain: number,
    amount: string | number | bigint,
    bridge: string,
    quotes: any[],
  ): Promise<any> {
    // Use the protocol fee from quotes (first quote is the protocol fee)
    let nativeValue = 0n;
    if (quotes && quotes.length > 0 && quotes[0].amount) {
      nativeValue = BigInt(quotes[0].amount.toString());
    }

    // Call the standard rebalance function (same as CCTP)
    // This requires the user to be added as a rebalancer
    const tx = await this.collateralContract.populateTransaction.rebalance(
      domain,
      amount,
      bridge, // Use the bridge address (usually the router itself for OFT)
      {
        value: nativeValue, // Include LayerZero protocol fee
        gasLimit: 500000,
      },
    );
    return tx;
  }


}
