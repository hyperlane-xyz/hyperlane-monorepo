import {
  Contract,
  PopulatedTransaction,
  constants as ethersConstants,
} from 'ethers';

import { ERC20__factory } from '@hyperlane-xyz/core';
import {
  Address,
  Domain,
  addressToBytes32,
  strip0x,
} from '@hyperlane-xyz/utils';

import type { MultiProviderAdapter } from '../../providers/MultiProviderAdapter.js';
import { ChainName } from '../../types.js';

import { EvmTokenAdapter } from './EvmTokenAdapter.js';
import {
  IHypTokenAdapter,
  InterchainGasQuote,
  QuoteTransferRemoteParams,
  TransferRemoteParams,
} from './ITokenAdapter.js';

/**
 * M0PortalTokenAdapter - Adapter for M0 Portal token transfers
 *
 * This adapter extends EvmTokenAdapter for basic ERC20 operations and adds
 * support for cross-chain transfers via the M0 Portal. The Portal handles
 * bridging of M0 Extension tokens (like mUSD) between chains.
 *
 * Key differences from standard ERC20:
 * - Approvals are made to the Portal contract (not the recipient)
 * - Cross-chain transfers use Portal's sendToken function
 * - M tokens use index-based accounting which can cause rounding
 */

// From https://github.com/m0-foundation/m-portal-v2/blob/main/evm/src/Portal.sol
const PORTAL_ABI = [
  'function sendToken(uint256 amount, address sourceToken, uint32 destinationChainId, bytes32 destinationToken, bytes32 recipient, bytes32 refundAddress, address bridgeAdapter, bytes calldata bridgeAdapterArgs) external payable returns (bytes32)',
  'function quote(uint32 destinationChainId, uint8 payloadType, address bridgeAdapter) external view returns (uint256)',
  'function currentIndex() external view returns (uint128)',
  'function mToken() external view returns (address)',
];

// The address of Hyperlane's bridge adapter used by M0 Portal to interact with Hyperlane Protocol.
// The address is the same across all EVM chains
const HYPERLANE_BRIDGE_ADAPTER = '0xfCc1d596Ad6cAb0b5394eAa447d8626813180f32';

// M0 Portal allows for different payload types
const TOKEN_TRANSFER_PAYLOAD_TYPE = 0;

// Hyperlane bridge adapter doesn't require any special arguments for token transfers
const EMPTY_BRIDGE_ADAPTER_ARGS = '0x';

export class M0PortalTokenAdapter
  extends EvmTokenAdapter
  implements IHypTokenAdapter<PopulatedTransaction>
{
  public readonly portalContract: Contract;

  constructor(
    multiProvider: MultiProviderAdapter,
    chainName: ChainName,
    private readonly portalAddress: Address,
    mTokenAddress: Address,
  ) {
    // Initialize parent EvmTokenAdapter with the M token
    super(chainName, multiProvider, { token: mTokenAddress }, ERC20__factory);

    // Initialize the Portal contract for cross-chain transfers
    this.portalContract = new Contract(
      this.portalAddress,
      PORTAL_ABI,
      this.getProvider(),
    );
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
    // Portal doesn't use traditional routers
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
  }: QuoteTransferRemoteParams): Promise<InterchainGasQuote> {
    const destinationChainId = this.multiProvider.getChainId(
      this.multiProvider.getChainName(destination),
    );

    // Use Portal's built-in gas estimation
    const gasQuote = await this.portalContract.quote(
      destinationChainId,
      TOKEN_TRANSFER_PAYLOAD_TYPE,
      HYPERLANE_BRIDGE_ADAPTER,
    );

    return {
      igpQuote: {
        addressOrDenom: undefined,
        amount: BigInt(gasQuote.toString()),
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
      params.interchainGas?.igpQuote?.amount ??
      (
        await this.quoteTransferRemoteGas({
          destination: params.destination,
          sender: params.fromAccountOwner,
        })
      ).igpQuote?.amount;

    // Use Portal's sendToken function to support M0 Extensions like mUSD
    // Both source and destination use the same token address (mUSD on both chains)
    return this.portalContract.populateTransaction.sendToken(
      BigInt(params.weiAmountOrId.toString()),
      this.addresses.token, // source token
      destinationChainId,
      addressToBytes32(this.addresses.token), // destination token (same address on both chains for mUSD)
      addressToBytes32(params.recipient),
      addressToBytes32(params.fromAccountOwner ?? ethersConstants.AddressZero), // refundAddress,
      HYPERLANE_BRIDGE_ADAPTER,
      EMPTY_BRIDGE_ADAPTER_ARGS,
      {
        value: gasQuote,
      },
    );
  }
}
