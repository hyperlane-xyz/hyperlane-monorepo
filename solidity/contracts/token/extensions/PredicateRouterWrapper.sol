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
import {AbstractPostDispatchHook} from "../../hooks/libs/AbstractPostDispatchHook.sol";
import {IPostDispatchHook} from "../../interfaces/hooks/IPostDispatchHook.sol";
import {TokenRouter} from "../libs/TokenRouter.sol";
import {Quote} from "../../interfaces/ITokenBridge.sol";
import {Quotes} from "../libs/Quotes.sol";

// ============ Predicate Imports ============
import {Attestation} from "@predicate/interfaces/IPredicateRegistry.sol";
import {PredicateClient} from "@predicate/mixins/PredicateClient.sol";

// ============ External Imports ============
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

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
contract PredicateRouterWrapper is
    AbstractPostDispatchHook,
    PredicateClient,
    Ownable
{
    using SafeERC20 for IERC20;

    // ============ Enums ============

    enum TokenType {
        Native,
        Synthetic,
        Collateral
    }

    // ============ Constants ============

    /// @notice Hook type identifier for Predicate router wrapper
    uint8 public constant override hookType =
        uint8(IPostDispatchHook.HookTypes.PREDICATE_ROUTER_WRAPPER);

    // ============ Immutables ============

    /// @notice The underlying TokenRouter (warp route) being wrapped
    TokenRouter public immutable warpRoute;

    /// @notice The ERC20 token managed by the warp route
    IERC20 public immutable token;

    /// @notice The type of token being wrapped
    TokenType public immutable tokenType;

    // ============ Storage ============

    /// @notice Flag set during transferRemoteWithAttestation, checked in postDispatch
    /// @dev This is the key bypass prevention mechanism
    bool public pendingAttestation;

    // ============ Errors ============

    /// @notice Thrown when a transfer bypasses the wrapper (pendingAttestation is false)
    error PredicateRouterWrapper__UnauthorizedTransfer();

    /// @notice Thrown when attestation validation fails
    error PredicateRouterWrapper__AttestationInvalid();

    /// @notice Thrown when warp route address is zero
    error PredicateRouterWrapper__InvalidWarpRoute();

    /// @notice Thrown when registry address is zero
    error PredicateRouterWrapper__InvalidRegistry();

    /// @notice Thrown when policy ID is empty
    error PredicateRouterWrapper__InvalidPolicy();

    /// @notice Thrown when insufficient ETH sent for native token transfer
    error PredicateRouterWrapper__InsufficientValue();

    /// @notice Thrown when postDispatch was not executed during transfer
    error PredicateRouterWrapper__PostDispatchNotExecuted();

    /// @notice Thrown when ETH withdrawal fails
    error PredicateRouterWrapper__WithdrawFailed();

    /// @notice Thrown when re-entry is detected
    error PredicateRouterWrapper__ReentryDetected();

    /// @notice Thrown when ETH refund to caller fails
    error PredicateRouterWrapper__RefundFailed();

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
        if (_registry == address(0))
            revert PredicateRouterWrapper__InvalidRegistry();
        if (bytes(_policyID).length == 0)
            revert PredicateRouterWrapper__InvalidPolicy();

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

        // Initialize PredicateClient (handles registry, policy storage and registration)
        _initPredicateClient(_registry, _policyID);

        // Infinite approval to warp route for collateral routes only
        if (
            tokenType == TokenType.Collateral ||
            tokenType == TokenType.Synthetic
        ) {
            token.forceApprove(_warpRoute, type(uint256).max);
        }
    }

    // ============ External Functions ============

    /**
     * @notice Transfer tokens with Predicate attestation validation
     * @dev This is the main entry point for compliance-gated transfers.
     *      The attestation must be signed by a registered attester for this contract's policy.
     * @param _attestation The Predicate attestation proving compliance
     * @param _destination The destination chain domain
     * @param _recipient The recipient address on destination (as bytes32)
     * @param _amount The amount of tokens to transfer
     * @return messageId The Hyperlane message ID
     */
    function transferRemoteWithAttestation(
        Attestation calldata _attestation,
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external payable returns (bytes32 messageId) {
        // 0. Defensive check against re-entry
        if (pendingAttestation)
            revert PredicateRouterWrapper__ReentryDetected();

        // 1. Build encoded signature for Predicate validation (full PredicateClient pattern)
        bytes memory encodedSigAndArgs = abi.encodeWithSelector(
            TokenRouter.transferRemote.selector,
            _destination,
            _recipient,
            _amount
        );

        // 2. Validate with Predicate (reverts if invalid)
        bool isValid = _authorizeTransaction(
            _attestation,
            encodedSigAndArgs,
            msg.sender,
            msg.value
        );
        if (!isValid) revert PredicateRouterWrapper__AttestationInvalid();

        emit TransferAuthorized(
            msg.sender,
            _destination,
            _recipient,
            _amount,
            _attestation.uuid
        );

        // 3. Set flag before external calls (CEI pattern - checked in postDispatch)
        pendingAttestation = true;

        // 4. Quote total amount needed from router (includes fees)
        Quote[] memory quotes = warpRoute.quoteTransferRemote(
            _destination,
            _recipient,
            _amount
        );

        // 5. Compute total native value required (fees + token amount for native type)
        uint256 totalNativeRequired = Quotes.extract(quotes, address(0));
        if (msg.value < totalNativeRequired)
            revert PredicateRouterWrapper__InsufficientValue();

        // 6. Handle ERC20 token transfer if applicable
        if (tokenType != TokenType.Native) {
            uint256 totalTokenRequired = Quotes.extract(quotes, address(token));
            token.safeTransferFrom(
                msg.sender,
                address(this),
                totalTokenRequired
            );
        }

        // 7. Call warp route forwarding only the required native amount
        (bool success, bytes memory returnData) = address(warpRoute).call{
            value: totalNativeRequired
        }(encodedSigAndArgs);

        if (!success) {
            assembly {
                revert(add(returnData, 32), mload(returnData))
            }
        }

        messageId = abi.decode(returnData, (bytes32));

        // postDispatch should have consumed the authorization flag synchronously
        if (pendingAttestation) {
            revert PredicateRouterWrapper__PostDispatchNotExecuted();
        }

        // 8. Refund excess native value to caller
        uint256 excess = msg.value - totalNativeRequired;
        if (excess > 0) {
            (bool refundSuccess, ) = msg.sender.call{value: excess}("");
            if (!refundSuccess) revert PredicateRouterWrapper__RefundFailed();
        }

        return messageId;
    }

    // ============ Hook Implementation ============

    /**
     * @notice Called by mailbox after dispatch - verifies transfer came from wrapper
     * @dev Reverts if pendingAttestation is false, meaning someone bypassed the wrapper
     */
    function _postDispatch(bytes calldata, bytes calldata) internal override {
        // Check that this transfer originated from transferRemoteWithAttestation
        if (!pendingAttestation) {
            revert PredicateRouterWrapper__UnauthorizedTransfer();
        }

        // Clear the flag
        pendingAttestation = false;
    }

    /**
     * @notice Quote returns 0 - this hook has no fee
     * @dev The actual gas fees are paid through the warp route's IGP hook
     */
    function _quoteDispatch(
        bytes calldata,
        bytes calldata
    ) internal pure override returns (uint256) {
        return 0;
    }

    // ============ IPredicateClient Implementation ============

    /**
     * @notice Updates the policy ID
     * @dev Implements IPredicateClient.setPolicyID
     * @param _policyID The new policy ID
     */
    function setPolicyID(string memory _policyID) external onlyOwner {
        if (bytes(_policyID).length == 0)
            revert PredicateRouterWrapper__InvalidPolicy();

        _setPolicyID(_policyID);
    }

    /**
     * @notice Updates the Predicate registry address
     * @dev Implements IPredicateClient.setRegistry
     * @param _registry The new registry address
     */
    function setRegistry(address _registry) external onlyOwner {
        if (_registry == address(0))
            revert PredicateRouterWrapper__InvalidRegistry();

        _setRegistry(_registry);
    }

    // ============ ETH Refund Handling ============

    /**
     * @notice Accepts ETH refunds from the warp route's hook
     * @dev The warp route sets msg.sender (this wrapper) as refund address.
     *      Without this function, ETH refunds would revert or be trapped.
     */
    receive() external payable {}

    /**
     * @notice Withdraws trapped ETH to owner
     * @dev Only callable by owner. Used to recover ETH refunds from hooks.
     */
    function withdrawETH() external onlyOwner {
        uint256 balance = address(this).balance;
        (bool success, ) = msg.sender.call{value: balance}("");
        if (!success) revert PredicateRouterWrapper__WithdrawFailed();
    }
}
