// SPDX-License-Identifier: Apache-2.0
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
import {ITokenBridge, ITokenFee, Quote} from "../../interfaces/ITokenBridge.sol";
import {TokenRouter} from "../libs/TokenRouter.sol";
import {PackageVersioned} from "../../PackageVersioned.sol";

// ============ External Imports ============
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title ERC4626RebalancingBridge
 * @author Abacus Works
 * @notice A local rebalancing bridge that wraps an ERC4626 vault for yield generation.
 * @dev This bridge is designed to be used with MovableCollateralRouter to allow
 *      rebalancers to deposit warp route collateral into an ERC4626 vault for yield.
 *
 *      Key features:
 *      - Implements ITokenBridge for compatibility with MovableCollateralRouter
 *      - Only operates locally (domain == mailbox.localDomain)
 *      - Tracks principal deposits separately from yield
 *      - Allows continual yield claiming to the warp route's fee recipient
 *      - Rebalancer can withdraw principal back to the warp route
 *
 *      Deposit Flow (via MovableCollateralRouter.rebalance):
 *      1. Warp route owner adds this bridge via addBridge(localDomain, bridge)
 *      2. Warp route approves this bridge to pull tokens (done in _addBridge)
 *      3. Rebalancer calls warpRoute.rebalance(localDomain, amount, bridge)
 *      4. rebalance() calls bridge.transferRemote() which pulls tokens and deposits to vault
 *      5. Yield accrues in the vault over time
 *
 *      Yield Claiming:
 *      - Anyone can call claimYield() to send accrued yield to the warp route's feeRecipient
 *      - Can be called repeatedly as yield accrues
 *
 *      Withdrawal Flow:
 *      - Call withdrawPrincipal() to withdraw assets from vault back to any recipient
 *      - Only withdrawable amount is tracked principal (not yield)
 */
contract ERC4626RebalancingBridge is ITokenBridge, PackageVersioned {
    using SafeERC20 for IERC20;
    using Math for uint256;

    // ============ Events ============

    /// @notice Emitted when assets are deposited into the vault
    event Deposited(address indexed depositor, uint256 assets, uint256 shares);

    /// @notice Emitted when principal is withdrawn back to the warp route
    event PrincipalWithdrawn(
        address indexed recipient,
        uint256 assets,
        uint256 shares
    );

    /// @notice Emitted when yield is claimed to the fee recipient
    event YieldClaimed(
        address indexed feeRecipient,
        uint256 yieldAmount,
        uint256 sharesBurned
    );

    // ============ Errors ============

    error InvalidVault();
    error InvalidWarpRoute();
    error AssetMismatch();
    error InsufficientPrincipal(uint256 requested, uint256 available);
    error NoYieldToClaim();
    error ZeroFeeRecipient();

    // ============ Immutables ============

    /// @notice The ERC4626 vault where collateral is deposited
    IERC4626 public immutable vault;

    /// @notice The underlying asset of the vault (same as warp route's token)
    IERC20 public immutable asset;

    /// @notice The warp route that this bridge serves
    TokenRouter public immutable warpRoute;

    // ============ Storage ============

    /// @notice Total principal assets deposited (excludes yield)
    uint256 public principalDeposited;

    // ============ Constructor ============

    /**
     * @notice Creates a new ERC4626RebalancingBridge
     * @param _vault The ERC4626 vault to deposit into
     * @param _warpRoute The warp route that will use this bridge
     */
    constructor(IERC4626 _vault, TokenRouter _warpRoute) {
        if (address(_vault) == address(0)) revert InvalidVault();
        if (address(_warpRoute) == address(0)) revert InvalidWarpRoute();

        vault = _vault;
        asset = IERC20(_vault.asset());
        warpRoute = _warpRoute;

        // Verify the vault's asset matches the warp route's token
        if (_warpRoute.token() != address(asset)) revert AssetMismatch();

        // Approve vault to pull assets for deposits
        asset.forceApprove(address(_vault), type(uint256).max);
    }

    // ============ ITokenBridge Implementation ============

    /**
     * @inheritdoc ITokenBridge
     * @notice Deposits assets from the warp route into the vault OR withdraws principal back
     * @dev When called by MovableCollateralRouter.rebalance():
     *      - If depositing: pulls tokens from warp route, deposits to vault
     *      - The warp route must have approved this bridge to pull tokens
     *
     *      When called to withdraw principal:
     *      - Withdraws from vault to the specified recipient
     *
     * @param _destination The domain (must be local domain)
     * @param _recipient The recipient of withdrawn assets (for withdrawals)
     * @param _amount The amount to deposit or withdraw
     * @return messageId Always returns bytes32(0) since no actual message is dispatched
     */
    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external payable override returns (bytes32 messageId) {
        // This is a local-only bridge
        // When called from rebalance(), msg.sender is the warp route
        // We pull tokens and deposit them into the vault

        // Pull tokens from caller (warp route has approved this bridge)
        asset.safeTransferFrom(msg.sender, address(this), _amount);

        // Track principal
        principalDeposited += _amount;

        // Deposit into vault
        uint256 shares = vault.deposit(_amount, address(this));

        emit Deposited(msg.sender, _amount, shares);

        // Return zero since no actual message is dispatched
        return bytes32(0);
    }

    /**
     * @notice Withdraws principal from the vault back to a recipient
     * @dev Only callable by authorized parties (rebalancer via warp route owner)
     * @param _recipient The recipient of the withdrawn assets
     * @param _amount The amount of principal to withdraw
     */
    function withdrawPrincipal(
        address _recipient,
        uint256 _amount
    ) external returns (uint256 assets) {
        if (_amount > principalDeposited) {
            revert InsufficientPrincipal(_amount, principalDeposited);
        }

        // Update principal tracking
        principalDeposited -= _amount;

        // Calculate shares needed to withdraw the exact amount of assets
        uint256 shares = vault.previewWithdraw(_amount);

        // Withdraw from vault directly to recipient
        assets = vault.withdraw(_amount, _recipient, address(this));

        emit PrincipalWithdrawn(_recipient, assets, shares);
    }

    /**
     * @inheritdoc ITokenFee
     * @notice Returns a quote for the transfer (always zero fees for local transfers)
     * @dev Since this is a local-only bridge with no cross-chain messaging,
     *      there are no fees. Returns the amount needed for the transfer.
     */
    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external view override returns (Quote[] memory quotes) {
        quotes = new Quote[](1);
        quotes[0] = Quote({
            token: address(asset),
            amount: 0 // No fees for local vault operations
        });
    }

    // ============ Yield Management ============

    /**
     * @notice Claims accrued yield and sends it to the warp route's fee recipient
     * @dev Anyone can call this to claim yield. The yield is the difference between
     *      the current redeemable assets and the tracked principal.
     * @return yieldAmount The amount of yield claimed
     */
    function claimYield() external returns (uint256 yieldAmount) {
        address recipient = warpRoute.feeRecipient();
        if (recipient == address(0)) revert ZeroFeeRecipient();

        yieldAmount = _calculateYield();
        if (yieldAmount == 0) revert NoYieldToClaim();

        // Calculate shares to burn for the yield amount
        // Use previewWithdraw which rounds up to ensure we don't over-withdraw
        uint256 sharesToBurn = vault.previewWithdraw(yieldAmount);

        // Withdraw yield to fee recipient
        vault.withdraw(yieldAmount, recipient, address(this));

        emit YieldClaimed(recipient, yieldAmount, sharesToBurn);
    }

    /**
     * @notice Calculates the current accrued yield
     * @dev Yield = total redeemable assets - principal deposited
     * @return yieldAmount The current yield amount available to claim
     */
    function calculateYield() external view returns (uint256 yieldAmount) {
        return _calculateYield();
    }

    /**
     * @notice Returns the total assets held in the vault for this bridge
     * @return The total assets redeemable from the vault
     */
    function totalAssets() external view returns (uint256) {
        return vault.convertToAssets(vault.balanceOf(address(this)));
    }

    /**
     * @notice Returns the total shares held in the vault for this bridge
     * @return The total vault shares owned by this bridge
     */
    function totalShares() external view returns (uint256) {
        return vault.balanceOf(address(this));
    }

    // ============ Internal Functions ============

    /**
     * @dev Calculates yield as the difference between current assets and principal
     */
    function _calculateYield() internal view returns (uint256) {
        uint256 currentAssets = vault.convertToAssets(
            vault.balanceOf(address(this))
        );
        if (currentAssets <= principalDeposited) {
            return 0;
        }
        return currentAssets - principalDeposited;
    }

    /**
     * @dev Converts bytes32 to address
     */
    function _bytes32ToAddress(
        bytes32 _bytes32
    ) internal pure returns (address) {
        return address(uint160(uint256(_bytes32)));
    }
}
