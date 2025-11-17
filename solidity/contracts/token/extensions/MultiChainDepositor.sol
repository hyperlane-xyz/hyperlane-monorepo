// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

// ============ Internal Imports ============
import {HypERC20Collateral} from "../HypERC20Collateral.sol";
import {HypERC4626Collateral} from "./HypERC4626Collateral.sol";
import {HypNative} from "../HypNative.sol";
import {InterchainAccountRouter} from "../../middleware/InterchainAccountRouter.sol";
import {CallLib} from "../../middleware/libs/Call.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {IMessageRecipient} from "../../interfaces/IMessageRecipient.sol";

// ============ External Imports ============
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

/**
 * @title MultiChainDepositor
 * @notice Facilitates cross-chain deposits using the Transfer and Call pattern.
 * Enables converting assets from origin chain to yield-bearing tokens on the destination chain
 * through an intermediate ERC4626 vault on the yield chain using Interchain Accounts (ICA).
 *
 * @dev Architecture Overview:
 * - Origin Chain (e.g., Arbitrum): Users deposit assets, contract initiates cross-chain flow
 * - Yield Chain (e.g., Ethereum): Contains ERC4626 vault, ICA executes vault operations
 * - Destination Chain (e.g., Incentiv): Users receive yield-bearing tokens representing vault shares
 *
 * @dev Flow:
 * 1. User calls depositToYieldVault() with assets on origin chain
 * 2. Contract transfers assets to ICA on yield chain via HypERC20Collateral bridge
 * 3. Contract transfers native tokens to ICA for gas funding via HypNative bridge
 * 4. ICA on yield chain executes:
 *    a. Approve vault to spend assets
 *    b. Call HypERC4626Collateral.transferRemote() which deposits to vault and bridges shares
 * 5. User receives yield-bearing tokens on destination chain via HypERC4626 synthetic token
 *
 * @dev Security Notes:
 * - All cross-chain calls are authenticated through Hyperlane's security model
 * - ICA ensures only this contract can execute calls on remote chains
 * - Vault integration follows ERC4626 standard for predictable yield behavior
 *
 * @author Abacus Works
 */
contract MultiChainDepositor {
    using SafeERC20 for IERC20;
    using TypeCasts for address;
    using TypeCasts for bytes32;

    // ============ Constants ============

    /// @notice Domain identifier for the origin chain where users initiate deposits (e.g., Arbitrum)
    uint32 public immutable originChain;

    /// @notice Domain identifier for the yield chain containing the vault (e.g., Ethereum)
    uint32 public immutable yieldChain;

    /// @notice Domain identifier for the destination chain where users receive yield tokens (e.g., Incentiv)
    uint32 public immutable destinationChain;

    /// @notice HypERC20Collateral bridge contract for asset transfers on origin chain
    HypERC20Collateral public immutable originTokenBridge;

    /// @notice HypERC4626Collateral bridge contract for vault share transfers on yield chain
    HypERC4626Collateral public immutable yieldVaultBridge;

    /// @notice HypNative bridge contract for native token transfers on origin chain (used for gas funding)
    HypNative public immutable originNativeBridge;

    /// @notice Interchain Account Router for executing cross-chain calls via ICA
    InterchainAccountRouter public immutable icaRouter;

    /// @notice The underlying asset token address on yield chain (e.g., USDC, USDT, DAI)
    IERC20 public immutable yieldChainAsset;

    // ============ Events ============

    /**
     * @notice Emitted when a cross-chain deposit is initiated
     * @param sender The address initiating the deposit on the origin chain
     * @param amount The amount of assets being deposited (in asset decimals)
     * @param finalRecipient The final recipient address for yield-bearing tokens on the destination chain
     */
    event DepositInitiated(
        address indexed sender,
        uint256 amount,
        address indexed finalRecipient
    );

    // ============ Constructor ============

    /**
     * @notice Constructs the MultiChainDepositor with required bridge contracts and chain configurations
     * @param _originChain Domain ID for the origin chain where deposits are initiated (e.g., Arbitrum)
     * @param _yieldChain Domain ID for the yield chain containing the vault (e.g., Ethereum)
     * @param _destinationChain Domain ID for the destination chain for final recipients (e.g., Incentiv)
     * @param _originTokenBridge Address of HypERC20Collateral contract on origin chain for asset transfers
     * @param _yieldVaultBridge Address of HypERC4626Collateral contract on yield chain for vault operations
     * @param _originNativeBridge Address of HypNative contract on origin chain for gas funding
     * @param _icaRouter Address of InterchainAccountRouter for executing remote calls
     * @param _yieldChainAsset Address of the underlying asset token on yield chain (e.g., USDC, USDT, DAI)
     */
    constructor(
        uint32 _originChain,
        uint32 _yieldChain,
        uint32 _destinationChain,
        address _originTokenBridge,
        address _yieldVaultBridge,
        address payable _originNativeBridge,
        address payable _icaRouter,
        address _yieldChainAsset
    ) {
        originChain = _originChain;
        yieldChain = _yieldChain;
        destinationChain = _destinationChain;
        originTokenBridge = HypERC20Collateral(_originTokenBridge);
        yieldVaultBridge = HypERC4626Collateral(_yieldVaultBridge);
        originNativeBridge = HypNative(_originNativeBridge);
        icaRouter = InterchainAccountRouter(_icaRouter);
        yieldChainAsset = IERC20(_yieldChainAsset);
    }

    // ============ External Functions ============

    /**
     * @notice Initiates a cross-chain deposit from origin chain assets to destination chain yield-bearing tokens
     * @dev This function implements the Transfer and Call pattern:
     * 1. Transfers assets from origin chain to the ICA on yield chain using HypERC20Collateral
     * 2. Transfers native tokens to fund ICA gas operations on yield chain
     * 3. The ICA on yield chain deposits assets to vault and transfers yield-bearing tokens to destination chain
     * @param _amount The amount of assets to deposit (in asset decimals)
     * @param _finalRecipient The final recipient address for yield-bearing tokens on destination chain
     * @param _yieldTransferGas The gas amount for the vault-to-destination transfer (used for native token funding)
     */
    function depositToYieldVault(
        uint256 _amount,
        address _finalRecipient,
        uint _yieldTransferGas
    ) external payable {
        require(_amount > 0, "Amount must be greater than 0");
        require(_finalRecipient != address(0), "Invalid recipient");

        // Transfer assets from sender to this contract
        IERC20 assetToken = IERC20(originTokenBridge.token());
        assetToken.safeTransferFrom(msg.sender, address(this), _amount);

        // Approve the bridge to spend assets
        assetToken.safeApprove(address(originTokenBridge), _amount);

        // Get the ICA address on yield chain
        address icaOnYieldChain = icaRouter.getRemoteInterchainAccount(
            yieldChain,
            address(this)
        );

        // Step 1: Transfer assets from origin chain to the ICA on yield chain
        // Using transferRemote with the ICA as recipient
        originTokenBridge.transferRemote{value: msg.value}(
            yieldChain,
            icaOnYieldChain.addressToBytes32(),
            _amount
        );

        // Step 1.5: Transfer native token from origin chain to the ICA on yield chain
        originNativeBridge.transferRemote{value: address(this).balance}(
            yieldChain,
            icaOnYieldChain.addressToBytes32(),
            _yieldTransferGas * 2
        );

        // Build the call for the ICA to execute on yield chain
        CallLib.Call[] memory calls = new CallLib.Call[](2);

        // Call 1: Approve yield vault bridge to spend assets
        calls[0] = CallLib.build({
            to: address(yieldChainAsset),
            value: 0,
            data: abi.encodeCall(
                IERC20.approve,
                (address(yieldVaultBridge), _amount)
            )
        });

        // Call 2: Call yield vault bridge to deposit assets and send yield-bearing tokens to final recipient on destination chain
        calls[1] = CallLib.build({
            to: address(yieldVaultBridge),
            value: _yieldTransferGas * 2,
            data: abi.encodeCall(
                HypERC4626Collateral.transferRemote,
                (destinationChain, _finalRecipient.addressToBytes32(), _amount)
            )
        });

        // Send the ICA message to execute these calls on yield chain
        icaRouter.callRemote{value: address(this).balance}(yieldChain, calls);

        emit DepositInitiated(msg.sender, _amount, _finalRecipient);
    }

    /**
     * @notice Estimates the total gas payment required for a complete cross-chain deposit operation
     * @dev Aggregates gas costs for all four operations:
     * 1. Asset transfer from origin to yield chain
     * 2. Native token transfer from origin to yield chain (for ICA gas funding)
     * 3. ICA execution on yield chain (vault deposit + bridge call)
     * 4. Vault shares transfer from yield to destination chain
     * @return totalGasPayment The total gas payment required in origin chain native token
     */
    function quoteDepositGasPayment()
        external
        view
        returns (uint256 totalGasPayment)
    {
        // Quote for the asset transfer (origin -> yield chain)
        uint256 assetTransferGas = originTokenBridge.quoteGasPayment(
            yieldChain
        );

        // Quote for the native token transfer (origin -> yield chain)
        uint256 nativeTransferGas = originNativeBridge.quoteGasPayment(
            yieldChain
        );

        // Quote for the ICA call on yield chain
        uint256 icaCallGas = icaRouter.quoteGasPayment(yieldChain);

        // Quote for the vault shares transfer (yield chain -> destination chain)
        uint256 vaultSharesTransferGas = yieldVaultBridge.quoteGasPayment(
            destinationChain
        );

        totalGasPayment =
            assetTransferGas +
            nativeTransferGas +
            icaCallGas +
            vaultSharesTransferGas;
    }

    /**
     * @notice Allows contract to receive ETH for gas payments
     * @dev Required for receiving native tokens that will be used to pay for cross-chain operations
     */
    receive() external payable {}
}
