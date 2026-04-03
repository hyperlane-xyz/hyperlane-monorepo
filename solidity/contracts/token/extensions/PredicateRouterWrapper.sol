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
import {TokenRouter} from "../libs/TokenRouter.sol";
import {ITokenBridge, Quote} from "../../interfaces/ITokenBridge.sol";
import {Quotes} from "../libs/Quotes.sol";
import {AbstractPredicateWrapper} from "../libs/AbstractPredicateWrapper.sol";

// ============ Predicate Imports ============
import {Attestation} from "@predicate/interfaces/IPredicateRegistry.sol";

// ============ External Imports ============
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title PredicateRouterWrapper
 * @author Abacus Works
 * @notice Wraps an existing TokenRouter with Predicate attestation validation.
 *         Acts as BOTH a user entry point AND a post-dispatch hook.
 * @dev Security model:
 *      1. User calls transferRemoteWithAttestation() on this wrapper
 *      2. Wrapper validates attestation via PredicateClient, sets pendingAttestation = true
 *      3. Wrapper calls warpRoute.transferRemote()
 *      4. WarpRoute dispatches message, mailbox calls this contract's postDispatch()
 *      5. postDispatch() verifies pendingAttestation == true, then clears it
 *
 *      If someone bypasses wrapper and calls warpRoute directly, postDispatch()
 *      will revert because pendingAttestation will be false.
 *
 * Usage:
 *      1. Deploy PredicateRouterWrapper pointing to existing warp route
 *      2. Set PredicateRouterWrapper as the hook on the warp route: warpRoute.setHook(predicateWrapper)
 *      3. Optionally aggregate with default hook for IGP using StaticAggregationHook
 *      4. Users call predicateWrapper.transferRemoteWithAttestation() instead of warpRoute.transferRemote()
 *
 * @custom:oz-version 4.9.x (uses Ownable without constructor argument)
 */
contract PredicateRouterWrapper is AbstractPredicateWrapper {
    using SafeERC20 for IERC20;

    // ============ Enums ============

    enum TokenType {
        Native,
        Synthetic,
        Collateral
    }

    // ============ Immutables ============

    /// @notice The underlying TokenRouter (warp route) being wrapped
    TokenRouter public immutable warpRoute;

    /// @notice The ERC20 token managed by the warp route
    IERC20 public immutable token;

    /// @notice The type of token being wrapped
    TokenType public immutable tokenType;

    // ============ Errors ============

    error PredicateRouterWrapper__InvalidWarpRoute();

    // ============ Events ============

    /// @notice Emitted when a transfer is authorized via attestation
    event TransferAuthorized(
        address indexed sender,
        uint32 indexed destination,
        bytes32 indexed recipient,
        uint256 amount,
        string uuid
    );

    // ============ Constructor ============

    /**
     * @notice Initializes the PredicateRouterWrapper
     * @dev Deployer becomes owner. Use transferOwnership() to change owner after deployment.
     * @param _warpRoute The underlying TokenRouter to wrap
     * @param _registry The Predicate registry address
     * @param _policyID The policy ID for attestation validation
     */
    constructor(
        address _warpRoute,
        address _registry,
        string memory _policyID
    ) {
        if (_warpRoute == address(0))
            revert PredicateRouterWrapper__InvalidWarpRoute();

        warpRoute = TokenRouter(_warpRoute);
        address tokenAddress = warpRoute.token();
        token = IERC20(tokenAddress);

        // Determine token type
        if (tokenAddress == address(0)) {
            tokenType = TokenType.Native;
        } else if (tokenAddress == _warpRoute) {
            tokenType = TokenType.Synthetic;
        } else {
            tokenType = TokenType.Collateral;
        }

        _initPredicateWrapperBase(_registry, _policyID);

        // Infinite approval to warp route for routes where it may pull tokens
        if (
            tokenType == TokenType.Collateral ||
            tokenType == TokenType.Synthetic
        ) {
            token.forceApprove(_warpRoute, type(uint256).max);
        }
    }

    // ============ ITokenFee Implementation ============

    /**
     * @notice Quotes the fees for a remote transfer by delegating to the underlying warp route
     */
    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external view override returns (Quote[] memory quotes) {
        return warpRoute.quoteTransferRemote(_destination, _recipient, _amount);
    }

    // ============ Internal Overrides ============

    function _transferRouter() internal view override returns (ITokenBridge) {
        return ITokenBridge(address(warpRoute));
    }

    function _isCrossDomain(uint32) internal pure override returns (bool) {
        return true;
    }

    function _emitTransferAuthorized(
        address sender,
        uint32 destination,
        bytes32 recipient,
        uint256 amount,
        string calldata uuid
    ) internal override {
        emit TransferAuthorized(sender, destination, recipient, amount, uuid);
    }

    function _pullTokens(Quote[] memory quotes) internal override {
        if (tokenType == TokenType.Native) return;
        uint256 totalTokenRequired = Quotes.extract(quotes, address(token));
        if (totalTokenRequired > 0) {
            token.safeTransferFrom(
                msg.sender,
                address(this),
                totalTokenRequired
            );
        }
    }
}
