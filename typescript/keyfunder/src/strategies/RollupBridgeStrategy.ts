import { ethers } from 'ethers';
import { IFundingStrategy } from './IFundingStrategy';
import { FundingAction, FundingExecutionResult, StrategyExecutionContext } from '../types';

export const OPTIMISM_PORTAL_ABI = [
  'function depositTransaction(address _to, uint256 _value, uint64 _gasLimit, bool _isCreation, bytes _data) payable',
];

export const ARBITRUM_INBOX_ABI = [
  'function createRetryableTicket(address to, uint256 l2CallValue, uint256 maxSubmissionCost, address excessFeeRefundAddress, address callValueRefundAddress, uint256 maxGas, uint256 gasPriceBid, bytes data) payable returns (uint256)',
];

export class RollupBridgeStrategy implements IFundingStrategy {
  public readonly name = 'rollupBridge';

  /**
   * Factory method for creating Contract instances (allows clean mocking in tests)
   */
  public getContract(address: string, abi: any, signer: ethers.Signer): ethers.Contract {
    return new ethers.Contract(address, abi, signer);
  }

  public async execute(
    action: FundingAction,
    context: StrategyExecutionContext,
    signerContext?: any
  ): Promise<FundingExecutionResult> {
    try {
      const signer: ethers.Signer = signerContext?.signer;
      if (!signer) {
        throw new Error('EVM Signer is required in signerContext for RollupBridgeStrategy');
      }

      const strategyConfig =
        context.strategyConfig ||
        context.chainConfig.strategyConfig;

      const isOptimism =
        action.strategy === 'opStackBridge' ||
        action.strategy === 'optimismPortal' ||
        Boolean(strategyConfig?.portalAddress);

      const isArbitrum =
        action.strategy === 'arbitrumInbox' ||
        action.strategy === 'arbitrum' ||
        Boolean(strategyConfig?.inboxAddress);

      if (isOptimism) {
        return await this.executeOpStack(action, context, signer, signerContext);
      } else if (isArbitrum) {
        return await this.executeArbitrum(action, context, signer, signerContext);
      } else {
        // Default to OP Stack if portalAddress exists or Arbitrum if inboxAddress exists
        const portalAddr = strategyConfig?.portalAddress || strategyConfig?.bridgeAddress;
        if (portalAddr) {
          return await this.executeOpStack(action, context, signer, signerContext);
        }
        throw new Error(
          `Cannot determine rollup bridge type (OP Stack vs Arbitrum) for strategy ${action.strategy}`
        );
      }
    } catch (err: any) {
      return {
        success: false,
        error: err.message || String(err),
      };
    }
  }

  private async executeOpStack(
    action: FundingAction,
    context: StrategyExecutionContext,
    signer: ethers.Signer,
    signerContext?: any
  ): Promise<FundingExecutionResult> {
    const strategyConfig =
      context.strategyConfig ||
      context.chainConfig.strategyConfig;

    const portalAddress =
      strategyConfig?.portalAddress ||
      strategyConfig?.bridgeAddress ||
      context.strategyConfig?.portalAddress ||
      context.strategyConfig?.bridgeAddress;

    if (!portalAddress) {
      throw new Error(`portalAddress is not configured for OP Stack bridge on chain ${action.chain}`);
    }

    const portalContract = this.getContract(portalAddress, OPTIMISM_PORTAL_ABI, signer);
    const l2GasLimit = strategyConfig?.l2GasLimit || 200000;
    const isCreation = false;
    const data = '0x';

    const txRequest = {
      value: action.requiredFunding,
      ...(signerContext?.gasOverrides || {}),
    };

    const tx = await portalContract.depositTransaction(
      action.recipient,
      action.requiredFunding,
      l2GasLimit,
      isCreation,
      data,
      txRequest
    );

    const receipt = await tx.wait(signerContext?.confirmations ?? 1);

    return {
      success: true,
      txHash: tx.hash,
      gasUsed: receipt ? BigInt(receipt.gasUsed.toString()) : undefined,
      effectiveGasPrice: receipt && receipt.gasPrice ? BigInt(receipt.gasPrice.toString()) : undefined,
    };
  }

  private async executeArbitrum(
    action: FundingAction,
    context: StrategyExecutionContext,
    signer: ethers.Signer,
    signerContext?: any
  ): Promise<FundingExecutionResult> {
    const strategyConfig =
      context.strategyConfig || context.chainConfig?.strategyConfig;

    const inboxAddress =
      strategyConfig?.inboxAddress ||
      strategyConfig?.bridgeAddress;

    if (!inboxAddress) {
      throw new Error(`inboxAddress is not configured for Arbitrum bridge on chain ${action.chain}`);
    }

    const inboxContract = this.getContract(inboxAddress, ARBITRUM_INBOX_ABI, signer);
    const signerAddress = typeof signer.getAddress === 'function' ? await signer.getAddress() : '0x1234567890123456789012345678901234567890';

    const l2CallValue = action.requiredFunding;
    const maxSubmissionCost = strategyConfig?.maxSubmissionCost
      ? ethers.parseUnits(strategyConfig.maxSubmissionCost, 18)
      : ethers.parseEther('0.001');

    const maxGas = strategyConfig?.maxGas
      ? BigInt(strategyConfig.maxGas)
      : 100000n;

    const gasPriceBid = strategyConfig?.gasPriceBid
      ? ethers.parseUnits(strategyConfig.gasPriceBid, 9)
      : ethers.parseUnits('0.1', 9); // 0.1 Gwei

    const excessFeeRefundAddress = signerAddress;
    const callValueRefundAddress = signerAddress;
    const data = '0x';

    const totalCost = l2CallValue + maxSubmissionCost + maxGas * gasPriceBid;

    const txRequest = {
      value: totalCost,
      ...(signerContext?.gasOverrides || {}),
    };

    const tx = await inboxContract.createRetryableTicket(
      action.recipient,
      l2CallValue,
      maxSubmissionCost,
      excessFeeRefundAddress,
      callValueRefundAddress,
      maxGas,
      gasPriceBid,
      data,
      txRequest
    );

    const receipt = await tx.wait(signerContext?.confirmations ?? 1);

    return {
      success: true,
      txHash: tx.hash,
      gasUsed: receipt ? BigInt(receipt.gasUsed.toString()) : undefined,
      effectiveGasPrice: receipt && receipt.gasPrice ? BigInt(receipt.gasPrice.toString()) : undefined,
    };
  }
}
