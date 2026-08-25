import { ethers } from 'ethers';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { SigningStargateClient, StdFee } from '@cosmjs/stargate';
import { IFundingStrategy } from './IFundingStrategy';
import { FundingAction, FundingExecutionResult, StrategyExecutionContext } from '../types';

export class DirectNativeStrategy implements IFundingStrategy {
  public readonly name = 'direct';

  public async execute(
    action: FundingAction,
    context: StrategyExecutionContext,
    signerContext?: any
  ): Promise<FundingExecutionResult> {
    try {
      switch (action.protocol) {
        case 'ethereum':
          return await this.executeEvm(action, context, signerContext);
        case 'sealevel':
          return await this.executeSolana(action, context, signerContext);
        case 'cosmos':
          return await this.executeCosmos(action, context, signerContext);
        default:
          return {
            success: false,
            error: `Unsupported protocol ${action.protocol} for DirectNativeStrategy`,
          };
      }
    } catch (err: any) {
      return {
        success: false,
        error: err.message || String(err),
      };
    }
  }

  private async executeEvm(
    action: FundingAction,
    context: StrategyExecutionContext,
    signerContext?: any
  ): Promise<FundingExecutionResult> {
    const signer: ethers.Signer = signerContext?.signer;
    if (!signer) {
      throw new Error('EVM Signer is required in signerContext');
    }

    const txRequest: ethers.TransactionRequest = {
      to: action.recipient,
      value: action.requiredFunding,
      ...(signerContext?.gasOverrides || {}),
    };

    const txResponse = await signer.sendTransaction(txRequest);
    const receipt = await txResponse.wait(signerContext?.confirmations ?? 1);

    return {
      success: true,
      txHash: txResponse.hash,
      gasUsed: receipt ? BigInt(receipt.gasUsed.toString()) : undefined,
      effectiveGasPrice: receipt && receipt.gasPrice ? BigInt(receipt.gasPrice.toString()) : undefined,
    };
  }

  private async executeSolana(
    action: FundingAction,
    context: StrategyExecutionContext,
    signerContext?: any
  ): Promise<FundingExecutionResult> {
    const keypair: Keypair = signerContext?.keypair;
    const connection: Connection =
      signerContext?.connection ||
      new Connection(context.rpcUrl || context.chainConfig.rpcUrl || 'https://api.mainnet-beta.solana.com');

    if (!keypair) {
      throw new Error('Solana Keypair is required in signerContext');
    }

    const recipientPubkey = new PublicKey(action.recipient);
    const lamports = Number(action.requiredFunding);

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: recipientPubkey,
        lamports,
      })
    );

    const txHash = await sendAndConfirmTransaction(connection, tx, [keypair], {
      commitment: 'confirmed',
    });

    return {
      success: true,
      txHash,
    };
  }

  private async executeCosmos(
    action: FundingAction,
    context: StrategyExecutionContext,
    signerContext?: any
  ): Promise<FundingExecutionResult> {
    const client: SigningStargateClient = signerContext?.stargateClient;
    const funderAddress: string = signerContext?.funderAddress || action.funderAddress;
    const denom = context.strategyConfig?.denom || action.tokenDenom || 'uatom';

    if (!client) {
      throw new Error('CosmJS SigningStargateClient is required in signerContext');
    }

    const fee: StdFee = signerContext?.fee || {
      amount: [{ denom, amount: '5000' }],
      gas: '200000',
    };

    const sendResult = await client.sendTokens(
      funderAddress,
      action.recipient,
      [{ denom, amount: action.requiredFunding.toString() }],
      fee,
      'Hyperlane Keyfunder top-up'
    );

    return {
      success: sendResult.code === 0,
      txHash: sendResult.transactionHash,
      gasUsed: BigInt(sendResult.gasUsed.toString()),
      error: sendResult.code !== 0 ? sendResult.rawLog : undefined,
    };
  }
}
