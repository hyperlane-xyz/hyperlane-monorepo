import { EthBridger, getArbitrumNetwork } from '@arbitrum/sdk';
import { CrossChainMessenger } from '@eth-optimism/sdk';
import { BigNumber, Signer, ethers } from 'ethers';
import { Logger } from 'pino';
import { Gauge } from 'prom-client';
import { format } from 'util';

import {
  BaseEvmAdapter,
  ChainName,
  HyperlaneIgp,
  MultiProtocolProvider,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { Contexts } from '../../../config/contexts.js';
import L1ETHGateway from '../../../scripts/funding/utils/L1ETHGateway.json' with { type: 'json' };
import L1MessageQueue from '../../../scripts/funding/utils/L1MessageQueue.json' with { type: 'json' };
import L1ScrollMessenger from '../../../scripts/funding/utils/L1ScrollMessenger.json' with { type: 'json' };
import { BaseAgentKey } from '../../agents/keys.js';
import { DeployEnvironment } from '../../config/environment.js';
import { FundableRole } from '../../roles.js';
import { L1_CHAIN, L2_CHAINS } from '../helpers.js';
import { FunderAddresses } from '../types.js';

import { IFundingAdapter } from './IFundingAdapter.js';

/**
 * EVM-specific implementation of the funding adapter
 * Extends BaseEvmAdapter to leverage EVM-specific functionality
 */
export class EVMFundingAdapter
  extends BaseEvmAdapter
  implements IFundingAdapter
{
  private readonly localMultiProvider: MultiProvider;
  private readonly igp: HyperlaneIgp;
  private readonly nativeBridges: Record<
    string,
    { l1ETHGateway: string; l1Messenger: string }
  >;
  private readonly L2Chains: ChainName[];
  private readonly L2ToL1: Record<ChainName, ChainName>;

  constructor(
    chainName: ChainName,
    private readonly multiProtocolProvider: MultiProtocolProvider,
    environment: DeployEnvironment,
    private readonly context: Contexts,
    private readonly fundingAddresses: FunderAddresses,
    public readonly logger: Logger,
    private readonly walletBalanceGauge: Gauge<string>,
  ) {
    super(chainName, multiProtocolProvider, fundingAddresses, logger);
    this.localMultiProvider = multiProtocolProvider.toMultiProvider();
    this.localMultiProvider.setSigner(chainName, this.getSigner());
    this.igp = HyperlaneIgp.fromAddressesMap(
      {
        [this.chainName]: this.fundingAddresses,
      },
      this.localMultiProvider,
    );
    this.nativeBridges = {
      scrollsepolia: {
        l1ETHGateway: '0x8A54A2347Da2562917304141ab67324615e9866d',
        l1Messenger: '0x50c7d3e7f7c656493D1D76aaa1a836CedfCBB16A',
      },
    };
    this.L2Chains = L2_CHAINS;
    this.L2ToL1 = {
      ...L2_CHAINS.reduce(
        (acc, chain) => {
          acc[chain] = L1_CHAIN;
          return acc;
        },
        {} as Record<ChainName, ChainName>,
      ),
    };
  }

  async getBalance(address: string): Promise<string> {
    return (await this.getProvider().getBalance(address)).toString();
  }

  async getFundingAmount(
    address: string,
    desiredBalance: number,
    fundingThresholdFactor: number,
    role: FundableRole,
  ): Promise<string> {
    const currentBalance = BigNumber.from(await this.getBalance(address));
    const desiredBalanceBigNumber = ethers.utils.parseEther(
      desiredBalance.toString(),
    );

    const delta = desiredBalanceBigNumber.sub(currentBalance);
    const minDelta = desiredBalanceBigNumber
      .mul(Math.floor(fundingThresholdFactor * 100))
      .div(100);

    this.logger.debug(
      {
        chain: this.chainName,
        currentBalance: ethers.utils.formatEther(currentBalance),
        desiredBalance: ethers.utils.formatEther(desiredBalanceBigNumber),
        delta: ethers.utils.formatEther(delta),
        minDelta: ethers.utils.formatEther(minDelta),
        fundingThresholdFactor,
        role,
      },
      'Funding amount',
    );
    return delta.gt(minDelta) ? delta.toString() : '0';
  }

  async fundKey(
    key: BaseAgentKey,
    desiredBalance: number,
    fundingThresholdFactor: number,
  ): Promise<void> {
    if (await this.shouldBridgeToL2()) {
      try {
        const funderAddress = await this.localMultiProvider.getSignerAddress(
          this.chainName,
        );
        // Bridge ETH to L2 before funding the desired key.
        // By bridging the funder with 5x the desired balance we save on L1 gas.
        const bridgeAmount = BigNumber.from(
          await this.getFundingAmount(
            funderAddress!,
            desiredBalance * 5,
            fundingThresholdFactor,
            key.role as FundableRole,
          ),
        );
        if (bridgeAmount.gt(0)) {
          await this.bridgeToL2(funderAddress!, bridgeAmount);
        }
      } catch (error) {
        this.logger.error(
          { chain: this.chainName, key: key.address, error: format(error) },
          'Error bridging to L2',
        );
        throw error;
      }
    }

    try {
      const fundingAmount = BigNumber.from(
        await this.getFundingAmount(
          key.address,
          desiredBalance,
          fundingThresholdFactor,
          key.role as FundableRole,
        ),
      );

      if (fundingAmount.eq(0)) {
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

      const funderAddress = await this.localMultiProvider.getSignerAddress(
        this.chainName,
      );
      this.logger.info(
        {
          chain: this.chainName,
          amount: ethers.utils.formatEther(fundingAmount),
          key: key.address,
          funder: {
            address: funderAddress,
            balance: ethers.utils.formatEther(
              await this.localMultiProvider
                .getSigner(this.chainName)
                .getBalance(),
            ),
          },
        },
        'Funding key',
      );

      const tx = await this.localMultiProvider.sendTransaction(this.chainName, {
        to: key.address,
        value: fundingAmount,
      });

      this.logger.info(
        {
          key: key.address,
          txUrl: this.localMultiProvider.tryGetExplorerTxUrl(this.chainName, {
            hash: tx.transactionHash,
          }),
          chain: this.chainName,
        },
        'Sent transaction',
      );
    } catch (error) {
      this.logger.error(
        {
          chain: this.chainName,
          key: key.address,
          error: format(error),
        },
        'Error funding key',
      );
      throw error;
    }
  }

  async claimFromIgp(claimThreshold: number): Promise<void> {
    const igpContract = this.igp.getContracts(
      this.chainName,
    ).interchainGasPaymaster;

    const igpBalance = await this.getProvider().getBalance(igpContract.address);

    this.logger.info(
      {
        chain: this.chainName,
        igpBalance: ethers.utils.formatEther(igpBalance),
        igpClaimThreshold: claimThreshold,
      },
      'Checking IGP balance',
    );

    // Convert the threshold to BigNumber
    const threshold = ethers.utils.parseEther(
      claimThreshold.toFixed(18).toString(),
    );

    if (igpBalance.gt(threshold)) {
      this.logger.info(
        { chain: this.chainName },
        'IGP balance exceeds claim threshold, claiming',
      );
      await this.localMultiProvider.sendTransaction(
        this.chainName,
        await igpContract.populateTransaction.claim(),
      );
    } else {
      this.logger.info(
        {
          chain: this.chainName,
        },
        'IGP balance does not exceed claim threshold, skipping',
      );
    }
  }

  async updateMetrics(environment: DeployEnvironment): Promise<void> {
    const funder = this.localMultiProvider.getSigner(this.chainName);
    const funderAddress = await funder.getAddress();

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
      .set(parseFloat(ethers.utils.formatEther(await funder.getBalance())));
  }

  async shouldBridgeToL2(): Promise<boolean> {
    return this.L2Chains.includes(this.chainName as ChainName);
  }

  async bridgeToL2(to: string, amount: BigNumber): Promise<void> {
    const l1Chain = this.L2ToL1[this.chainName];
    this.logger.info(
      {
        l1Chain,
        l2Chain: this.chainName,
        amount: ethers.utils.formatEther(amount),
      },
      'Bridging ETH to L2',
    );

    let tx;
    if (
      this.chainName.includes('optimism') ||
      this.chainName.includes('base')
    ) {
      tx = await this.bridgeToOptimism(amount, to);
    } else if (this.chainName.includes('arbitrum')) {
      tx = await this.bridgeToArbitrum(amount);
    } else if (this.chainName.includes('scroll')) {
      tx = await this.bridgeToScroll(amount, to);
    } else {
      throw new Error(`${this.chainName} is not a supported L2`);
    }

    await this.localMultiProvider.handleTx(l1Chain, tx);
  }

  private async bridgeToOptimism(amount: BigNumber, to: string): Promise<any> {
    const l1Chain = this.L2ToL1[this.chainName];

    const l1Provider = this.multiProtocolProvider.getProvider(l1Chain)
      .provider as ethers.providers.Provider;

    let l1Signer = this.multiProtocolProvider.getSigner(l1Chain)
      .signer as Signer;
    l1Signer = l1Signer.connect(l1Provider);

    const crossChainMessenger = new CrossChainMessenger({
      l1ChainId: this.multiProtocolProvider.getEvmChainId(l1Chain),
      l2ChainId: this.localMultiProvider.getEvmChainId(this.chainName),
      l1SignerOrProvider: l1Signer,
      l2SignerOrProvider: this.localMultiProvider.getSignerOrProvider(
        this.chainName,
      ),
    });
    this.logger.info(
      {
        amount: ethers.utils.formatEther(amount),
        to,
      },
      'Bridge to Optimism',
    );
    return crossChainMessenger.depositETH(amount, {
      recipient: to,
      overrides:
        this.multiProtocolProvider.metadata[l1Chain].transactionOverrides,
    });
  }

  private async bridgeToArbitrum(amount: BigNumber): Promise<any> {
    const l1Chain = this.L2ToL1[this.chainName];
    const l2Network = await getArbitrumNetwork(
      this.localMultiProvider.getEvmChainId(this.chainName),
    );

    let l1Signer = this.multiProtocolProvider.getSigner(l1Chain)
      .signer as Signer;
    const l1Provider = this.multiProtocolProvider.getProvider(l1Chain)
      .provider as ethers.providers.Provider;
    l1Signer = l1Signer.connect(l1Provider);

    const overrides =
      this.multiProtocolProvider.metadata[l1Chain].transactionOverrides;

    const ethBridger = new EthBridger(l2Network);
    this.logger.info(
      {
        l1Signer,
        l1Provider,
        overrides,
      },
      'Bridging to Arbitrum',
    );
    return ethBridger.deposit({
      amount,
      parentSigner: l1Signer,
      overrides,
    });
  }

  private async bridgeToScroll(amount: BigNumber, to: Address): Promise<any> {
    const l1Chain = this.L2ToL1[this.chainName];
    let l1ChainSigner = this.multiProtocolProvider.getSigner(l1Chain)
      .signer as Signer;
    const l1Provider = this.multiProtocolProvider.getProvider(l1Chain)
      .provider as ethers.providers.Provider;
    l1ChainSigner = l1ChainSigner.connect(l1Provider);

    const l1EthGateway = new ethers.Contract(
      this.nativeBridges.scrollsepolia.l1ETHGateway,
      L1ETHGateway.abi,
      l1ChainSigner,
    );
    const l1ScrollMessenger = new ethers.Contract(
      this.nativeBridges.scrollsepolia.l1Messenger,
      L1ScrollMessenger.abi,
      l1ChainSigner,
    );
    const l2GasLimit = BigNumber.from('200000');
    const l1MessageQueueAddress = await l1ScrollMessenger.messageQueue();
    const l1MessageQueue = new ethers.Contract(
      l1MessageQueueAddress,
      L1MessageQueue.abi,
      l1ChainSigner,
    );
    const gasQuote =
      await l1MessageQueue.estimateCrossDomainMessageFee(l2GasLimit);
    const totalAmount = amount.add(gasQuote);
    this.logger.info(
      {
        totalAmount: ethers.utils.formatEther(totalAmount),
        gasQuote: ethers.utils.formatEther(gasQuote),
        amount: ethers.utils.formatEther(amount),
      },
      'Bridge to Scroll',
    );
    return l1EthGateway['depositETH(address,uint256,uint256)'](
      to,
      amount,
      l2GasLimit,
      { value: totalAmount },
    );
  }
}
