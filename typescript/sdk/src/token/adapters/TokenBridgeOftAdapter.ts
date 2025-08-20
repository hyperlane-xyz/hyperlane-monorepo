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
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { token: Address },
    public readonly oftTokenAddress: Address,
  ) {
    super(chainName, multiProvider, addresses);
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
      console.error(`Failed to get OFT balance for ${this.chainName}:`, error);
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
  override async isRebalancer(address: Address): Promise<boolean> {
    // Since we use native OFT send() directly, we don't need rebalancer permissions
    return true;
  }

  /**
   * Override to allow any bridge since we use native OFT bridging
   */
  override async isBridgeAllowed(domain: number, bridge: Address): Promise<boolean> {
    // Since we use native OFT send() directly, any bridge is allowed
    return true;
  }

  /**
   * Override to get quotes from the native OFT bridge instead of TokenBridgeOft
   */
  override async getRebalanceQuotes(
    bridge: Address,
    domain: number,
    recipient: Address,
    amount: string | number | bigint,
    isWarp: boolean,
  ): Promise<any[]> {
    // Use the native OFT quoteSend function
    const oftContract = new ethers.Contract(
      this.oftTokenAddress,
      [
        'function quoteSend((uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd), bool payInLzToken) view returns (uint256 msgFee, uint256 lzTokenFee)',
      ],
      this.getProvider(),
    );

    try {
      // LayerZero EID for the destination domain (you'll need to map domain to LZ EID)
      const lzEid = this.mapDomainToLzEid(domain);
      const recipientBytes32 = ethers.utils.hexZeroPad(recipient, 32);
      
      const sendParam = {
        dstEid: lzEid,
        to: recipientBytes32,
        amountLD: amount,
        minAmountLD: amount,
        extraOptions: '0x',
        composeMsg: '0x',
        oftCmd: '0x',
      };

      const [msgFee] = await oftContract.quoteSend(sendParam, false);
      
      return [{ amount: BigInt(msgFee.toString()) }];
    } catch (error) {
      console.error(`Failed to get OFT quote for ${this.chainName}:`, error);
      // Fallback to parent method
      return super.getRebalanceQuotes(bridge, domain, recipient, amount, isWarp);
    }
  }

  /**
   * Override to use native OFT send instead of TokenBridgeOft rebalance
   */
  override async populateRebalanceTx(
    domain: number,
    amount: string | number | bigint,
    bridge: Address,
    quotes: any[],
  ): Promise<any> {
    // Use the native OFT send function
    const oftContract = new ethers.Contract(
      this.oftTokenAddress,
      [
        'function send((uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd), (uint256 msgFee, uint256 lzTokenFee), address refundTo) payable returns (uint256 amountSentLD, uint256 amountReceivedLD)',
      ],
      this.getProvider(),
    );

    const lzEid = this.mapDomainToLzEid(domain);
    const bridgeBytes32 = ethers.utils.hexZeroPad(bridge, 32);
    
    const sendParam = {
      dstEid: lzEid,
      to: bridgeBytes32,
      amountLD: amount,
      minAmountLD: amount,
      extraOptions: '0x',
      composeMsg: '0x',
      oftCmd: '0x',
    };

    const fee = { msgFee: quotes[0]?.amount || 0n, lzTokenFee: 0n };
    const refundTo = ethers.constants.AddressZero; // Simplified for now

    return oftContract.populateTransaction.send(sendParam, fee, refundTo, {
      value: fee.msgFee,
    });
  }

  /**
   * Map Hyperlane domain ID to LayerZero EID
   * This is a simplified mapping - in production, this should come from config
   */
  private mapDomainToLzEid(domain: number): number {
    const domainToEidMap: Record<number, number> = {
      11155111: 40161, // Sepolia
      421614: 40231,   // Arbitrum Sepolia
      11155420: 40232, // Optimism Sepolia
    };
    
    const eid = domainToEidMap[domain];
    if (!eid) {
      throw new Error(`No LayerZero EID mapping found for domain ${domain}`);
    }
    return eid;
  }
}
