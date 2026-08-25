import { ethers } from 'ethers';
import { PublicKey } from '@solana/web3.js';
import { IFundingStrategy } from './IFundingStrategy';
import { FundingAction, FundingExecutionResult, StrategyExecutionContext } from '../types';

export const WARP_ROUTE_ABI = [
  'function transferRemote(uint32 _destinationDomain, bytes32 _recipient, uint256 _amountOrId) payable returns (bytes32 messageId)',
  'function quoteGasPayment(uint32 _destinationDomain) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

export class WarpRouteStrategy implements IFundingStrategy {
  public readonly name = 'warpRoute';

  /**
   * Factory method for creating Contract instances (allows clean mocking in tests)
   */
  public getContract(address: string, abi: any, signer: ethers.Signer): ethers.Contract {
    return new ethers.Contract(address, abi, signer);
  }

  /**
   * Convert various protocol recipient addresses to bytes32 format for Hyperlane
   */
  public addressToBytes32(address: string, protocol?: string): string {
    const trimmed = address.trim();

    // Already 32-byte hex string (66 chars including 0x)
    if (trimmed.startsWith('0x') && trimmed.length === 66) {
      return trimmed;
    }

    // 20-byte EVM address (42 chars including 0x)
    if (trimmed.startsWith('0x') && trimmed.length === 42) {
      return ethers.zeroPadValue(trimmed, 32);
    }

    // Try Solana Base58 public key
    try {
      const pubkey = new PublicKey(trimmed);
      return ethers.hexlify(pubkey.toBytes());
    } catch {
      // Fallback for Bech32 or other string address: zero-pad utf8 bytes
      const bytes = ethers.toUtf8Bytes(trimmed);
      if (bytes.length <= 32) {
        return ethers.zeroPadValue(ethers.hexlify(bytes), 32);
      }
      return ethers.keccak256(bytes);
    }
  }

  public async execute(
    action: FundingAction,
    context: StrategyExecutionContext,
    signerContext?: any
  ): Promise<FundingExecutionResult> {
    try {
      const signer: ethers.Signer = signerContext?.signer;
      if (!signer) {
        throw new Error('EVM Signer is required in signerContext for WarpRouteStrategy');
      }

      const strategyConfig =
        context.strategyConfig || context.chainConfig?.strategyConfig;

      const warpRouteAddress = strategyConfig?.warpRouteAddress;

      if (!warpRouteAddress) {
        throw new Error(`warpRouteAddress is not specified in strategy configuration for chain ${action.chain}`);
      }

      const destinationDomain = strategyConfig?.destinationDomain;

      if (destinationDomain === undefined) {
        throw new Error(`destinationDomain is not specified in strategy configuration for chain ${action.chain}`);
      }

      const warpContract = this.getContract(warpRouteAddress, WARP_ROUTE_ABI, signer);
      const recipientBytes32 = this.addressToBytes32(action.recipient, action.protocol);

      // Quote interchain gas payment if possible
      let gasQuote = 0n;
      try {
        gasQuote = await warpContract.quoteGasPayment(destinationDomain);
      } catch {
        // Contract may not implement quoteGasPayment or destination is zero fee
        gasQuote = 0n;
      }

      // Check if native warp route or ERC20 warp route
      // For native route, msg.value = action.requiredFunding + gasQuote
      // For ERC20 route, msg.value = gasQuote, and we ensure approval
      let valueToSend = action.requiredFunding + gasQuote;

      if (action.tokenAddress && action.tokenAddress !== ethers.ZeroAddress) {
        // ERC20 token warp route
        const tokenContract = this.getContract(
          action.tokenAddress,
          [
            'function allowance(address owner, address spender) view returns (uint256)',
            'function approve(address spender, uint256 amount) returns (bool)',
          ],
          signer
        );
        const ownerAddr = await signer.getAddress();
        const allowance: bigint = await tokenContract.allowance(ownerAddr, warpRouteAddress);
        if (allowance < action.requiredFunding) {
          const approveTx = await tokenContract.approve(warpRouteAddress, ethers.MaxUint256);
          await approveTx.wait(1);
        }
        valueToSend = gasQuote;
      }

      const txRequest = {
        value: valueToSend,
        ...(signerContext?.gasOverrides || {}),
      };

      const tx = await warpContract.transferRemote(
        destinationDomain,
        recipientBytes32,
        action.requiredFunding,
        txRequest
      );

      const receipt = await tx.wait(signerContext?.confirmations ?? 1);

      return {
        success: true,
        txHash: tx.hash,
        gasUsed: receipt ? BigInt(receipt.gasUsed.toString()) : undefined,
        effectiveGasPrice: receipt && receipt.gasPrice ? BigInt(receipt.gasPrice.toString()) : undefined,
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message || String(err),
      };
    }
  }
}
