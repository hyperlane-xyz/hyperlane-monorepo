import {
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { Logger } from 'pino';
import { Gauge } from 'prom-client';

import {
  BaseSealevelAdapter,
  ChainMap,
  ChainName,
  MultiProtocolProvider,
  SEALEVEL_PRIORITY_FEES,
  SealevelIgpAdapter,
} from '@hyperlane-xyz/sdk';

import { Contexts } from '../../../config/contexts.js';
import { BaseAgentKey } from '../../agents/keys.js';
import { DeployEnvironment } from '../../config/environment.js';
import { FundableRole } from '../../roles.js';
import { FundingAddresses } from '../types.js';

import { IFundingAdapter } from './IFundingAdapter.js';

/**
 * Sealevel-specific implementation of the funding adapter
 */
export class SealevelFundingAdapter
  extends BaseSealevelAdapter
  implements IFundingAdapter
{
  private igpAdapter: SealevelIgpAdapter;
  private igpProgramIds: ChainMap<string>;

  constructor(
    chainName: ChainName,
    multiProvider: MultiProtocolProvider,
    environment: DeployEnvironment,
    private readonly context: Contexts,
    private readonly fundingAddresses: FundingAddresses,
    public readonly logger: Logger,
    private readonly walletBalanceGauge: Gauge<string>,
  ) {
    super(chainName, multiProvider, fundingAddresses, logger);
    this.logger = logger;
    // TODO: this should be a config that is passed in
    this.igpProgramIds = {
      solanamainnet: 'BhNcatUDC2D5JTyeaqrdSukiVFsEHK7e3hVmKMztwefv',
      sonicsvm: '3kd3K1yymsfYoqzNnktLwpKXKeB9Y2PRf9rfb31k4o13',
      soon: '5AAMBemjUrAprKJzi22Si9pyYhK8vTr7Jpti7LEXo6d8',
      eclipsemainnet: 'Hs7KVBU67nBnWhDPZkEFwWqrFMUfJbmY2DQ4gmCZfaZp',
    };
    this.igpAdapter = new SealevelIgpAdapter(
      this.chainName,
      this.multiProvider,
      {
        igp: this.fundingAddresses.interchainGasPaymaster,
        programId: this.getIgpProgramId(),
      },
    );
  }

  async getBalance(address: string): Promise<bigint> {
    const response = await this.getProvider().getBalanceAndContext(
      new PublicKey(address),
    );
    // Get the raw value from the RPC response before it's converted to number
    return BigInt(response.value);
  }

  async getFundingAmount(
    address: string,
    desiredBalance: number,
    fundingThresholdFactor: number,
    role: FundableRole,
  ): Promise<bigint> {
    // Get current balance in lamports
    const currentBalanceLamports = await this.getBalance(address);
    const desiredBalanceLamports = BigInt(
      Math.floor(desiredBalance * LAMPORTS_PER_SOL),
    );

    // Calculate delta and minimum threshold
    const delta = desiredBalanceLamports - currentBalanceLamports;
    const minDelta =
      (desiredBalanceLamports * BigInt(fundingThresholdFactor * 100)) / 100n;
    // Determine if funding is needed
    const fundingAmount = delta > minDelta ? delta : 0n;

    this.logger.info(
      {
        chain: this.chainName,
        currentBalance: currentBalanceLamports.toString(),
        desiredBalance: desiredBalanceLamports.toString(),
        delta: delta.toString(),
        minDelta: minDelta.toString(),
        fundingThresholdFactor,
        role,
      },
      'Funding amount',
    );
    return fundingAmount;
  }

  async fundKey(
    key: BaseAgentKey,
    desiredBalance: number,
    fundingThresholdFactor: number,
  ): Promise<void> {
    const fundingAmountLamports = await this.getFundingAmount(
      key.address,
      desiredBalance,
      fundingThresholdFactor,
      key.role as FundableRole,
    );

    if (fundingAmountLamports === 0n) {
      this.logger.info(
        {
          key: key.address,
          chain: this.chainName,
          role: key.role,
        },
        'Skipping funding for key',
      );
      return;
    }

    const fundingAmountSol = fundingAmountLamports / BigInt(LAMPORTS_PER_SOL);
    const funderAddress = this.getSigner().publicKey.toBase58();

    const funderBalanceLamports = await this.getBalance(funderAddress);
    const funderBalanceSol = funderBalanceLamports / BigInt(LAMPORTS_PER_SOL);

    const fromPubkey = new PublicKey(funderAddress);
    const toPubkey = new PublicKey(key.address);

    this.logger.info(
      {
        chain: this.chainName,
        amount: fundingAmountSol.toString(),
        key: key.address,
        funder: {
          address: funderAddress,
          balance: funderBalanceSol.toString(),
        },
        context: this.context,
      },
      'Funding key',
    );

    try {
      // Get latest blockhash for transaction
      const { blockhash, lastValidBlockHeight } =
        await this.getProvider().getLatestBlockhash('finalized');

      // Create transaction
      const transaction = new Transaction({
        feePayer: fromPubkey,
        blockhash,
        lastValidBlockHeight,
      });

      // Add transfer instruction
      transaction.add(
        SystemProgram.transfer({
          fromPubkey,
          toPubkey,
          lamports: fundingAmountLamports,
        }),
      );

      // Add priority fee if configured for this chain
      const priorityFee = SEALEVEL_PRIORITY_FEES[this.chainName];
      if (priorityFee) {
        transaction.add(
          ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: priorityFee,
          }),
        );
      }

      // Send and confirm transaction
      const signature = await sendAndConfirmTransaction(
        this.getProvider(),
        transaction,
        [this.getSigner()],
      );

      this.logger.info(
        {
          key: key.address,
          signature,
          amount: fundingAmountSol.toString(),
          chain: this.chainName,
        },
        'Successfully funded key',
      );
    } catch (error) {
      this.logger.error(
        {
          error,
          key: key.address,
          amount: fundingAmountSol.toString(),
          chain: this.chainName,
        },
        'Failed to fund key',
      );
      throw error;
    }
  }

  async claimFromIgp(claimThreshold: number): Promise<void> {
    const claimThresholdLamports = BigInt(claimThreshold * LAMPORTS_PER_SOL);
    const igpPublicKey = (await this.igpAdapter.getPaymentKeys()).igpAccount;
    const igpBalanceLamports = await this.getBalance(igpPublicKey.toBase58());

    this.logger.info(
      {
        chain: this.chainName,
        igpBalance: (igpBalanceLamports / BigInt(LAMPORTS_PER_SOL)).toString(),
        igpClaimThreshold: claimThreshold,
      },
      'Checking IGP balance',
    );

    if (igpBalanceLamports < claimThresholdLamports) {
      this.logger.info(
        {
          chain: this.chainName,
        },
        'IGP balance does not exceed claim threshold, skipping',
      );
      return;
    }

    this.logger.info(
      {
        chain: this.chainName,
      },
      'IGP balance exceeds claim threshold, claiming',
    );

    try {
      // Populate claim transaction
      const transaction = await this.igpAdapter.populateClaimTx(
        this.getSigner().publicKey,
      );

      // Send and confirm transaction
      await sendAndConfirmTransaction(this.getProvider(), transaction, [
        this.getSigner(),
      ]);

      this.logger.info(
        {
          chain: this.chainName,
        },
        'Successfully claimed from IGP',
      );
    } catch (error) {
      this.logger.error(
        {
          error,
          chain: this.chainName,
        },
        'Failed to claim from IGP',
      );
      throw error;
    }
  }

  /**
   * Gets the IGP program ID for the given IGP address
   */
  private getIgpProgramId(): string {
    return this.igpProgramIds[this.chainName];
  }

  async updateMetrics(environment: DeployEnvironment): Promise<void> {
    const funder = this.getSigner();
    const funderAddress = funder.publicKey.toBase58();

    const balance = await this.getBalance(funderAddress);
    const balanceSol = Number(balance) / LAMPORTS_PER_SOL;

    this.walletBalanceGauge
      .labels({
        chain: this.chainName,
        wallet_address: funderAddress,
        wallet_name: 'key-funder',
        token_symbol: 'Native',
        token_name: 'Native',
        hyperlane_deployment: environment,
        hyperlane_context: Contexts.Hyperlane,
      })
      .set(balanceSol);
  }
}
