import {
  Contract,
  PopulatedTransaction,
  constants as ethersConstants,
} from 'ethers';

import { ERC20__factory } from '@hyperlane-xyz/core';
import {
  Address,
  Domain,
  Numberish,
  addressToBytes32,
} from '@hyperlane-xyz/utils';

import { BaseEvmAdapter } from '../../app/MultiProtocolApp.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ChainName } from '../../types.js';
import { TokenMetadata } from '../types.js';

import {
  IHypTokenAdapter,
  ITokenAdapter,
  InterchainGasQuote,
  TransferParams,
  TransferRemoteParams,
} from './ITokenAdapter.js';

/**
 * M0PortalLiteTokenAdapter - Simplified adapter for M0 PortalLite token transfers
 *
 * This adapter treats the M0 Portal as a bridge that handles cross-chain transfers
 * of M tokens. It does not handle index accounting or supply tracking - just basic
 * token operations and cross-chain transfers.
 */
export class M0PortalLiteTokenAdapter
  extends BaseEvmAdapter
  implements
    ITokenAdapter<PopulatedTransaction>,
    IHypTokenAdapter<PopulatedTransaction>
{
  constructor(
    multiProvider: MultiProtocolProvider,
    chain: ChainName,
    private readonly portalAddress: Address,
    private readonly mTokenAddress: Address,
  ) {
    super(chain, multiProvider, {
      portal: portalAddress,
      mToken: mTokenAddress,
    });
  }

  private getPortalContract(): Contract {
    const provider = this.getProvider();
    const abi = [
      'function transfer(uint256 amount, uint256 destinationChainId, address recipient, address refundAddress) external payable returns (bytes32)',
      'function transferMLikeToken(uint256 amount, address sourceToken, uint256 destinationChainId, address destinationToken, address recipient, address refundAddress) external payable returns (bytes32)',
      'function quoteTransfer(uint256 amount, uint256 destinationChainId, address recipient) external view returns (uint256)',
      'function currentIndex() external view returns (uint128)',
      'function mToken() external view returns (address)',
    ];
    return new Contract(this.portalAddress, abi, provider);
  }

  private getMTokenContract() {
    return ERC20__factory.connect(this.mTokenAddress, this.getProvider());
  }

  // ========== ITokenAdapter implementation ==========

  async getBalance(address: Address): Promise<bigint> {
    const mTokenContract = this.getMTokenContract();
    const balance = await mTokenContract.balanceOf(address);
    return BigInt(balance.toString());
  }

  async getTotalSupply(): Promise<bigint | undefined> {
    try {
      const mTokenContract = this.getMTokenContract();
      const totalSupply = await mTokenContract.totalSupply();
      return BigInt(totalSupply.toString());
    } catch {
      return undefined;
    }
  }

  async getMetadata(isNft?: boolean): Promise<TokenMetadata> {
    const mTokenContract = this.getMTokenContract();
    const [name, symbol, decimals] = await Promise.all([
      mTokenContract.name(),
      mTokenContract.symbol(),
      isNft ? 0 : mTokenContract.decimals(),
    ]);

    return {
      name,
      symbol,
      decimals,
    };
  }

  async getMinimumTransferAmount(_recipient: Address): Promise<bigint> {
    // M tokens use index-based accounting which can cause rounding
    // Return a small minimum to avoid rounding to 0
    return 1n;
  }

  async isApproveRequired(
    owner: Address,
    _spender: Address,
    weiAmountOrId: Numberish,
  ): Promise<boolean> {
    const mTokenContract = this.getMTokenContract();
    // Check allowance against the Portal contract
    const allowance = await mTokenContract.allowance(owner, this.portalAddress);
    return BigInt(allowance.toString()) < BigInt(weiAmountOrId.toString());
  }

  async isRevokeApprovalRequired(
    owner: Address,
    _spender: Address,
  ): Promise<boolean> {
    const mTokenContract = this.getMTokenContract();
    const allowance = await mTokenContract.allowance(owner, this.portalAddress);
    return BigInt(allowance.toString()) > 0n;
  }

  async populateApproveTx(
    params: TransferParams,
  ): Promise<PopulatedTransaction> {
    const mTokenContract = this.getMTokenContract();
    return mTokenContract.populateTransaction.approve(
      this.portalAddress,
      params.weiAmountOrId,
    );
  }

  async populateTransferTx(
    params: TransferParams,
  ): Promise<PopulatedTransaction> {
    // For local (same-chain) transfers, use M token directly
    const mTokenContract = this.getMTokenContract();
    return mTokenContract.populateTransaction.transfer(
      params.recipient,
      params.weiAmountOrId,
    );
  }

  // ========== IHypTokenAdapter implementation ==========

  async getDomains(): Promise<Domain[]> {
    // This should be configured based on deployment
    // For now return empty - configuration will come from WarpCore config
    return [];
  }

  async getRouterAddress(domain: Domain): Promise<Buffer> {
    // PortalLite doesn't use traditional routers
    // Return the portal address as the "router"
    return Buffer.from(addressToBytes32(this.portalAddress).slice(2), 'hex');
  }

  async getAllRouters(): Promise<Array<{ domain: Domain; address: Buffer }>> {
    const domains = await this.getDomains();
    return domains.map((domain) => ({
      domain,
      address: Buffer.from(
        addressToBytes32(this.portalAddress).slice(2),
        'hex',
      ),
    }));
  }

  async getBridgedSupply(): Promise<bigint | undefined> {
    // For simple transfer support, we don't need bridged supply tracking
    // WarpCore can work without this for basic transfers
    return undefined;
  }

  async quoteTransferRemoteGas(
    destination: Domain,
    sender?: Address,
    _customHook?: Address,
  ): Promise<InterchainGasQuote> {
    const destinationChainId = this.multiProvider.getChainId(
      this.multiProvider.getChainName(destination),
    );

    // Use PortalLite's built-in gas estimation
    const portal = this.getPortalContract();
    const gasQuote = await portal.quoteTransfer(
      1n, // Amount doesn't affect gas quote
      destinationChainId,
      sender || ethersConstants.AddressZero, // Recipient doesn't affect quote
    );

    return {
      amount: BigInt(gasQuote.toString()),
      addressOrDenom: undefined, // Native token payment
    };
  }

  async populateTransferRemoteTx(
    params: TransferRemoteParams,
  ): Promise<PopulatedTransaction> {
    const destinationChainId = this.multiProvider.getChainId(
      this.multiProvider.getChainName(params.destination),
    );

    // Get gas quote if not provided
    const gasQuote =
      params.interchainGas?.amount ||
      (
        await this.quoteTransferRemoteGas(
          params.destination,
          params.fromAccountOwner,
        )
      ).amount;

    const portal = this.getPortalContract();

    // Use Portal's transferMLikeToken function to support wrapped tokens like mUSD
    // Both source and destination use the same token address (mUSD on both chains)
    return portal.populateTransaction.transferMLikeToken(
      BigInt(params.weiAmountOrId.toString()),
      this.mTokenAddress, // source token
      destinationChainId,
      this.mTokenAddress, // destination token (same address on both chains for mUSD)
      params.recipient,
      params.fromAccountOwner || ethersConstants.AddressZero, // refundAddress
      {
        value: gasQuote,
      },
    );
  }
}
