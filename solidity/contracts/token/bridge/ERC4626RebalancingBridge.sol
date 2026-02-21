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
import {MovableCollateralRouter} from "../libs/MovableCollateralRouter.sol";
import {PackageVersioned} from "../../PackageVersioned.sol";

// ============ External Imports ============
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title ERC4626RebalancingBridge
 * @author Abacus Works
 * @notice Local bridge that deposits warp route collateral into an ERC4626 vault for yield.
 * @dev Used with MovableCollateralRouter. Rebalancers call warpRoute.rebalance() which
 *      invokes transferRemote() to deposit into the vault. Yield accrues to feeRecipient.
 */
contract ERC4626RebalancingBridge is ITokenBridge, PackageVersioned {
    using SafeERC20 for IERC20;

    // ============ Events ============

    event PrincipalDeposited(
        address indexed depositor,
        uint256 assets,
        uint256 shares
    );
    event PrincipalWithdrawn(
        address indexed recipient,
        uint256 assets,
        uint256 shares
    );
    event YieldClaimed(
        address indexed feeRecipient,
        uint256 yieldAmount,
        uint256 sharesBurned
    );

    // ============ Errors ============

    error InvalidVault();
    error InvalidWarpRoute();
    error AssetMismatch();
    error ZeroAmount();
    error OnlyWarpRoute(address caller);
    error InsufficientPrincipal(uint256 requested, uint256 available);
    error NoYieldToClaim();
    error ZeroFeeRecipient();
    error NotAllowedRebalancer(address caller);

    // ============ Immutables ============

    IERC4626 public immutable vault;
    IERC20 public immutable asset;
    TokenRouter public immutable warpRoute;

    // ============ Storage ============

    /// @notice Principal deposited (excludes accrued yield)
    uint256 public principalDeposited;

    // ============ Constructor ============

    constructor(IERC4626 _vault, TokenRouter _warpRoute) {
        if (address(_vault) == address(0)) revert InvalidVault();
        if (address(_warpRoute) == address(0)) revert InvalidWarpRoute();

        vault = _vault;
        asset = IERC20(_vault.asset());
        warpRoute = _warpRoute;

        if (_warpRoute.token() != address(asset)) revert AssetMismatch();

        asset.forceApprove(address(_vault), type(uint256).max);
    }

    // ============ ITokenBridge Implementation ============

    /**
     * @inheritdoc ITokenBridge
     * @dev Pulls tokens from warp route and deposits into vault. Only callable by warp route.
     */
    function transferRemote(
        uint32, // _destination - unused, local-only bridge
        bytes32, // _recipient - unused, local-only bridge
        uint256 _amount
    ) external payable override returns (bytes32) {
        if (msg.sender != address(warpRoute)) revert OnlyWarpRoute(msg.sender);
        if (_amount == 0) revert ZeroAmount();

        asset.safeTransferFrom(msg.sender, address(this), _amount);
        principalDeposited += _amount;
        uint256 shares = vault.deposit(_amount, address(this));
        emit PrincipalDeposited(msg.sender, _amount, shares);
        return bytes32(0);
    }

    /**
     * @notice Withdraws principal from vault back to warp route
     * @dev Only allowed rebalancers can call. Withdraws to warp route, not caller.
     *      Auto-claims any accrued yield before withdrawing principal.
     */
    function withdrawPrincipal(
        uint256 _amount
    ) external returns (uint256 assets) {
        if (_amount == 0) revert ZeroAmount();
        if (!_isAllowedRebalancer(msg.sender)) {
            revert NotAllowedRebalancer(msg.sender);
        }
        if (_amount > principalDeposited) {
            revert InsufficientPrincipal(_amount, principalDeposited);
        }

        _claimYield();

        principalDeposited -= _amount;
        uint256 shares = vault.previewWithdraw(_amount);
        address recipient = address(warpRoute);
        assets = vault.withdraw(_amount, recipient, address(this));

        emit PrincipalWithdrawn(recipient, assets, shares);
    }

    /**
     * @inheritdoc ITokenFee
     * @dev No fees charged. Returns the transfer amount as the required token amount.
     */
    function quoteTransferRemote(
        uint32, // _destination - unused, local-only bridge
        bytes32, // _recipient - unused, local-only bridge
        uint256 _amount
    ) external view override returns (Quote[] memory quotes) {
        quotes = new Quote[](1);
        quotes[0] = Quote({token: address(asset), amount: _amount});
    }

    // ============ Yield Management ============

    /**
     * @notice Claims accrued yield to the warp route's feeRecipient
     * @dev Anyone can call. Yield = current vault assets - principal.
     */
    function claimYield() external returns (uint256 yieldAmount) {
        address recipient = warpRoute.feeRecipient();
        if (recipient == address(0)) revert ZeroFeeRecipient();

        yieldAmount = _calculateYield();
        if (yieldAmount == 0) revert NoYieldToClaim();

        uint256 sharesToBurn = vault.previewWithdraw(yieldAmount);
        vault.withdraw(yieldAmount, recipient, address(this));

        emit YieldClaimed(recipient, yieldAmount, sharesToBurn);
    }

    // ============ Internal Functions ============

    /**
     * @notice Internal yield claim — silently skips if no yield or no feeRecipient
     * @dev Used by withdrawPrincipal to auto-claim without reverting
     */
    function _claimYield() internal {
        address recipient = warpRoute.feeRecipient();
        if (recipient == address(0)) return;

        uint256 yieldAmount = _calculateYield();
        if (yieldAmount == 0) return;

        uint256 sharesToBurn = vault.previewWithdraw(yieldAmount);
        vault.withdraw(yieldAmount, recipient, address(this));

        emit YieldClaimed(recipient, yieldAmount, sharesToBurn);
    }

    /// @notice Returns current claimable yield
    function calculateYield() external view returns (uint256) {
        return _calculateYield();
    }

    function _calculateYield() internal view returns (uint256) {
        uint256 currentAssets = vault.convertToAssets(
            vault.balanceOf(address(this))
        );
        return
            currentAssets > principalDeposited
                ? currentAssets - principalDeposited
                : 0;
    }

    function _isAllowedRebalancer(
        address _address
    ) internal view returns (bool) {
        address[] memory rebalancers = MovableCollateralRouter(
            address(warpRoute)
        ).allowedRebalancers();
        for (uint256 i = 0; i < rebalancers.length; i++) {
            if (rebalancers[i] == _address) return true;
        }
        return false;
    }
}
