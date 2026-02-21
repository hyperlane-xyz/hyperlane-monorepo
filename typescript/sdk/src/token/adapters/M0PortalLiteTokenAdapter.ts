import {
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  zeroAddress,
} from 'viem';

import { ERC20__factory } from '@hyperlane-xyz/core';
import {
  Address,
  Domain,
  addressToBytes32,
  strip0x,
} from '@hyperlane-xyz/utils';

import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ChainName } from '../../types.js';

import { EvmTokenAdapter } from './EvmTokenAdapter.js';
import {
  IHypTokenAdapter,
  InterchainGasQuote,
  QuoteTransferRemoteParams,
  TransferRemoteParams,
} from './ITokenAdapter.js';

type PopulatedTransaction = Awaited<
  ReturnType<EvmTokenAdapter['populateApproveTx']>
>;

/**
 * M0PortalLiteTokenAdapter - Adapter for M0 PortalLite token transfers
 *
 * This adapter extends EvmTokenAdapter for basic ERC20 operations and adds
 * support for cross-chain transfers via the M0 Portal. The Portal handles
 * bridging of M tokens (like mUSD) between chains.
 *
 * Key differences from standard ERC20:
 * - Approvals are made to the Portal contract (not the recipient)
 * - Cross-chain transfers use Portal's transferMLikeToken function
 * - M tokens use index-based accounting which can cause rounding
 */

// From https://github.com/m0-foundation/m-portal-lite/blob/main/src/Portal.sol
const PORTAL_LITE_ABI = parseAbi([
  'function transfer(uint256 amount, uint256 destinationChainId, address recipient, address refundAddress) external payable returns (bytes32)',
  'function transferMLikeToken(uint256 amount, address sourceToken, uint256 destinationChainId, address destinationToken, address recipient, address refundAddress) external payable returns (bytes32)',
  'function quoteTransfer(uint256 amount, uint256 destinationChainId, address recipient) external view returns (uint256)',
  'function currentIndex() external view returns (uint128)',
  'function mToken() external view returns (address)',
]);

export class M0PortalLiteTokenAdapter
  extends EvmTokenAdapter
  implements IHypTokenAdapter<PopulatedTransaction>
{
  constructor(
    multiProvider: MultiProtocolProvider,
    chainName: ChainName,
    private readonly portalAddress: Address,
    mTokenAddress: Address,
  ) {
    // Initialize parent EvmTokenAdapter with the M token
    super(chainName, multiProvider, { token: mTokenAddress }, ERC20__factory);
  }

  // ========== ITokenAdapter overrides ==========

  override async getMinimumTransferAmount(
    _recipient: Address,
  ): Promise<bigint> {
    // M tokens use index-based accounting which can cause rounding
    // Return a small minimum to avoid rounding to 0
    return 1n;
  }

  // ========== IHypTokenAdapter implementation ==========

  async getDomains(): Promise<Domain[]> {
    // This should be configured based on deployment
    // For now return empty - configuration will come from WarpCore config
    return [];
  }

  async getRouterAddress(_domain: Domain): Promise<Buffer> {
    // PortalLite doesn't use traditional routers
    // Return the portal address as the "router"
    return Buffer.from(strip0x(addressToBytes32(this.portalAddress)), 'hex');
  }

  async getAllRouters(): Promise<Array<{ domain: Domain; address: Buffer }>> {
    return [];
  }

  async getBridgedSupply(): Promise<bigint | undefined> {
    // For simple transfer support, we don't need bridged supply tracking
    // WarpCore can work without this for basic transfers
    return undefined;
  }

  async quoteTransferRemoteGas({
    destination,
    sender,
  }: QuoteTransferRemoteParams): Promise<InterchainGasQuote> {
    const destinationChainId = this.multiProvider.getChainId(
      this.multiProvider.getChainName(destination),
    );

    // Use PortalLite's built-in gas estimation
    const result = await (this.getProvider() as any).call({
      to: this.portalAddress as `0x${string}`,
      data: encodeFunctionData({
        abi: PORTAL_LITE_ABI,
        functionName: 'quoteTransfer',
        args: [
          1n, // Amount doesn't affect gas quote
          BigInt(destinationChainId),
          (sender || zeroAddress) as `0x${string}`, // Recipient doesn't affect quote
        ],
      }) as `0x${string}`,
    });
    const gasQuote = decodeFunctionResult({
      abi: PORTAL_LITE_ABI,
      functionName: 'quoteTransfer',
      data: result as `0x${string}`,
    });

    return {
      igpQuote: {
        addressOrDenom: '',
        amount: gasQuote,
      },
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
      params.interchainGas?.igpQuote?.amount ||
      (
        await this.quoteTransferRemoteGas({
          destination: params.destination,
          sender: params.fromAccountOwner,
        })
      ).igpQuote?.amount;

    // Use Portal's transferMLikeToken function to support wrapped tokens like mUSD
    // Both source and destination use the same token address (mUSD on both chains)
    return {
      to: this.portalAddress as `0x${string}`,
      data: encodeFunctionData({
        abi: PORTAL_LITE_ABI,
        functionName: 'transferMLikeToken',
        args: [
          BigInt(params.weiAmountOrId.toString()),
          this.addresses.token as `0x${string}`, // source token
          BigInt(destinationChainId),
          this.addresses.token as `0x${string}`, // destination token (same address on both chains for mUSD)
          params.recipient as `0x${string}`,
          (params.fromAccountOwner || zeroAddress) as `0x${string}`, // refundAddress
        ],
      }),
      value: gasQuote,
    } as any as PopulatedTransaction;
  }
}
