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

// ============ Core Imports ============
import {AbstractPostDispatchHook} from "@hyperlane-xyz/core/hooks/libs/AbstractPostDispatchHook.sol";
import {IPostDispatchHook} from "@hyperlane-xyz/core/interfaces/hooks/IPostDispatchHook.sol";
import {Quote} from "@hyperlane-xyz/core/interfaces/ITokenBridge.sol";

// ============ Predicate Imports ============
import {Attestation} from "@predicate/interfaces/IPredicateRegistry.sol";
import {PredicateClient} from "@predicate/mixins/PredicateClient.sol";

// ============ External Imports ============
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

// ============ Local Imports ============
import {CrossCollateralRouter} from "./CrossCollateralRouter.sol";

/**
 * @title PredicateCrossCollateralRouterWrapper
 * @author Abacus Works
 * @notice Wraps an existing CrossCollateralRouter with Predicate attestation validation.
 *         Acts as BOTH a user entry point AND a post-dispatch hook.
 * @dev Security model:
 *      1. User calls transferRemoteWithAttestation() or transferRemoteToWithAttestation()
 *      2. Wrapper validates attestation via PredicateClient, sets pendingAttestation = true
 *      3. Wrapper calls crossCollateralRouter.transferRemote() or transferRemoteTo()
 *      4. For cross-domain: CrossCollateralRouter dispatches message, mailbox calls postDispatch()
 *      5. For same-domain: CrossCollateralRouter calls handle() directly, no postDispatch
 *      6. postDispatch() verifies pendingAttestation == true (cross-domain only), then clears it
 *
 *      If someone bypasses wrapper and calls crossCollateralRouter directly, postDispatch()
 *      will revert because pendingAttestation will be false.
 *
 * Usage:
 *      1. Deploy PredicateCrossCollateralRouterWrapper pointing to existing CrossCollateralRouter
 *      2. Set PredicateCrossCollateralRouterWrapper as the hook: router.setHook(predicateWrapper)
 *      3. Optionally aggregate with default hook for IGP using StaticAggregationHook
 *      4. Users call wrapper.transferRemoteWithAttestation() or transferRemoteToWithAttestation()
 *
 * @custom:oz-version 4.9.x (uses Ownable without constructor argument)
 */
contract PredicateCrossCollateralRouterWrapper is
    AbstractPostDispatchHook,
    PredicateClient,
    Ownable
{
    using SafeERC20 for IERC20;

    // ============ Constants ============

    /// @notice Hook type identifier for Predicate cross-collateral router wrapper
    uint8 public constant override hookType =
        uint8(IPostDispatchHook.HookTypes.PREDICATE_ROUTER_WRAPPER);

    // ============ Immutables ============

    /// @notice The underlying CrossCollateralRouter being wrapped
    CrossCollateralRouter public immutable crossCollateralRouter;

    /// @notice The ERC20 token managed by the cross-collateral router
    IERC20 public immutable token;

    /// @notice The local domain ID (cached from router during construction)
    uint32 public immutable localDomain;

    // ============ Storage ============

    /// @notice Flag set during transferRemoteWithAttestation, checked in postDispatch
    /// @dev This is the key bypass prevention mechanism
    bool public pendingAttestation;

    // ============ Errors ============

    /// @notice Thrown when a transfer bypasses the wrapper (pendingAttestation is false)
    error PredicateCrossCollateralRouterWrapper__UnauthorizedTransfer();

    /// @notice Thrown when attestation validation fails
    error PredicateCrossCollateralRouterWrapper__AttestationInvalid();

    /// @notice Thrown when router address is zero
    error PredicateCrossCollateralRouterWrapper__InvalidRouter();

    /// @notice Thrown when registry address is zero
    error PredicateCrossCollateralRouterWrapper__InvalidRegistry();

    /// @notice Thrown when policy ID is empty
    error PredicateCrossCollateralRouterWrapper__InvalidPolicy();

    /// @notice Thrown when postDispatch was not executed during cross-domain transfer
    error PredicateCrossCollateralRouterWrapper__PostDispatchNotExecuted();

    /// @notice Thrown when ETH withdrawal fails
    error PredicateCrossCollateralRouterWrapper__WithdrawFailed();

    /// @notice Thrown when re-entry is detected
    error PredicateCrossCollateralRouterWrapper__ReentryDetected();

    // ============ Events ============

    /// @notice Emitted when a transfer is authorized via attestation
    event TransferAuthorized(
        address indexed sender,
        uint32 indexed destination,
        bytes32 indexed recipient,
        uint256 amount,
        bytes32 targetRouter,
        string uuid
    );

    // ============ Constructor ============

    /**
     * @notice Initializes the PredicateCrossCollateralRouterWrapper
     * @dev Deployer becomes owner. Use transferOwnership() to change owner after deployment.
     * @param _crossCollateralRouter The underlying CrossCollateralRouter to wrap
     * @param _registry The Predicate registry address
     * @param _policyID The policy ID for attestation validation
     */
    constructor(
        address _crossCollateralRouter,
        address _registry,
        string memory _policyID
    ) {
        if (_crossCollateralRouter == address(0))
            revert PredicateCrossCollateralRouterWrapper__InvalidRouter();
        if (_registry == address(0))
            revert PredicateCrossCollateralRouterWrapper__InvalidRegistry();
        if (bytes(_policyID).length == 0)
            revert PredicateCrossCollateralRouterWrapper__InvalidPolicy();

        crossCollateralRouter = CrossCollateralRouter(_crossCollateralRouter);
        address tokenAddress = crossCollateralRouter.token();
        token = IERC20(tokenAddress);
        localDomain = crossCollateralRouter.localDomain();

        // Initialize PredicateClient (handles registry, policy storage and registration)
        _initPredicateClient(_registry, _policyID);

        // Infinite approval to cross-collateral router for token transfers
        token.forceApprove(_crossCollateralRouter, type(uint256).max);
    }

    // ============ External Functions ============

    /**
     * @notice Transfer tokens to primary enrolled router with Predicate attestation validation
     * @dev This wraps CrossCollateralRouter.transferRemote, which uses the primary enrolled
     *      router for the destination. The attestation must be signed by a registered attester.
     * @param _attestation The Predicate attestation proving compliance
     * @param _destination The destination chain domain
     * @param _recipient The recipient address on destination (as bytes32)
     * @param _amount The amount of tokens to transfer
     * @return messageId The Hyperlane message ID (0 for same-domain transfers)
     */
    function transferRemoteWithAttestation(
        Attestation calldata _attestation,
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external payable returns (bytes32 messageId) {
        // 0. Defensive check against re-entry
        if (pendingAttestation)
            revert PredicateCrossCollateralRouterWrapper__ReentryDetected();

        // 1. Build encoded signature for Predicate validation
        bytes memory encodedSigAndArgs = abi.encodeWithSelector(
            CrossCollateralRouter.transferRemote.selector,
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
        if (!isValid)
            revert PredicateCrossCollateralRouterWrapper__AttestationInvalid();

        emit TransferAuthorized(
            msg.sender,
            _destination,
            _recipient,
            _amount,
            bytes32(0), // No specific router for transferRemote
            _attestation.uuid
        );

        // 3. Quote total amount needed from router (includes fees)
        Quote[] memory quotes = crossCollateralRouter.quoteTransferRemote(
            _destination,
            _recipient,
            _amount
        );

        // 4. Handle token transfer, pulling total quoted amount
        _handleTokenTransfer(quotes);

        // 5. Set flag for cross-domain only (same-domain doesn't use postDispatch)
        bool isCrossDomain = _destination != localDomain;
        if (isCrossDomain) {
            pendingAttestation = true;
        }

        // 6. Call cross-collateral router using already-encoded calldata
        // This reuses the same calldata that was validated in the attestation
        (bool success, bytes memory returnData) = address(crossCollateralRouter)
            .call{value: msg.value}(encodedSigAndArgs);

        if (!success) {
            // Bubble up revert reason from router
            assembly {
                revert(add(returnData, 32), mload(returnData))
            }
        }

        // 7. For cross-domain: postDispatch should have consumed the authorization flag synchronously
        //    For same-domain: no flag was set, no postDispatch
        if (isCrossDomain && pendingAttestation) {
            revert PredicateCrossCollateralRouterWrapper__PostDispatchNotExecuted();
        }

        // Note: pendingAttestation is cleared in _postDispatch() for cross-domain
        // If we reach here, the transfer succeeded
        messageId = success ? abi.decode(returnData, (bytes32)) : bytes32(0);
        return messageId;
    }

    /**
     * @notice Transfer tokens to specific target router with Predicate attestation validation
     * @dev This wraps CrossCollateralRouter.transferRemoteTo, which allows specifying the
     *      target router. The attestation must be signed by a registered attester and includes
     *      the targetRouter parameter.
     * @param _attestation The Predicate attestation proving compliance
     * @param _destination The destination chain domain
     * @param _recipient The recipient address on destination (as bytes32)
     * @param _amount The amount of tokens to transfer
     * @param _targetRouter The enrolled router to receive the message on destination
     * @return messageId The Hyperlane message ID (0 for same-domain transfers)
     */
    function transferRemoteToWithAttestation(
        Attestation calldata _attestation,
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        bytes32 _targetRouter
    ) external payable returns (bytes32 messageId) {
        // 0. Defensive check against re-entry
        if (pendingAttestation)
            revert PredicateCrossCollateralRouterWrapper__ReentryDetected();

        // 1. Build encoded signature for Predicate validation (includes targetRouter)
        bytes memory encodedSigAndArgs = abi.encodeWithSelector(
            CrossCollateralRouter.transferRemoteTo.selector,
            _destination,
            _recipient,
            _amount,
            _targetRouter
        );

        // 2. Validate with Predicate (reverts if invalid)
        bool isValid = _authorizeTransaction(
            _attestation,
            encodedSigAndArgs,
            msg.sender,
            msg.value
        );
        if (!isValid)
            revert PredicateCrossCollateralRouterWrapper__AttestationInvalid();

        emit TransferAuthorized(
            msg.sender,
            _destination,
            _recipient,
            _amount,
            _targetRouter,
            _attestation.uuid
        );

        // 3. Quote total amount needed from router (includes fees, router-aware)
        Quote[] memory quotes = crossCollateralRouter.quoteTransferRemoteTo(
            _destination,
            _recipient,
            _amount,
            _targetRouter
        );

        // 4. Handle token transfer, pulling total quoted amount
        _handleTokenTransfer(quotes);

        // 5. Set flag for cross-domain only (same-domain doesn't use postDispatch)
        bool isCrossDomain = _destination != localDomain;
        if (isCrossDomain) {
            pendingAttestation = true;
        }

        // 6. Call cross-collateral router using already-encoded calldata
        // This reuses the same calldata that was validated in the attestation
        (bool success, bytes memory returnData) = address(crossCollateralRouter)
            .call{value: msg.value}(encodedSigAndArgs);

        if (!success) {
            // Bubble up revert reason from router
            assembly {
                revert(add(returnData, 32), mload(returnData))
            }
        }

        // 7. For cross-domain: postDispatch should have consumed the authorization flag synchronously
        //    For same-domain: no flag was set, no postDispatch
        if (isCrossDomain && pendingAttestation) {
            revert PredicateCrossCollateralRouterWrapper__PostDispatchNotExecuted();
        }

        // Note: pendingAttestation is cleared in _postDispatch() for cross-domain
        // If we reach here, the transfer succeeded
        messageId = success ? abi.decode(returnData, (bytes32)) : bytes32(0);
        return messageId;
    }

    // ============ Internal Functions ============

    /**
     * @notice Handle token transfer by pulling tokens from user based on quotes
     * @dev Sums all token quote amounts and pulls from msg.sender
     * @param quotes The quotes from crossCollateralRouter.quoteTransferRemote[To]
     */
    function _handleTokenTransfer(Quote[] memory quotes) internal {
        uint256 totalTokenRequired = 0;
        address tokenAddr = address(token);

        for (uint256 i = 0; i < quotes.length; i++) {
            if (quotes[i].token == tokenAddr) {
                totalTokenRequired += quotes[i].amount;
            }
        }

        if (totalTokenRequired > 0) {
            token.safeTransferFrom(
                msg.sender,
                address(this),
                totalTokenRequired
            );
        }
    }

    // ============ Hook Implementation ============

    /**
     * @notice Called by mailbox after dispatch - verifies transfer came from wrapper
     * @dev Reverts if pendingAttestation is false, meaning someone bypassed the wrapper
     */
    function _postDispatch(bytes calldata, bytes calldata) internal override {
        // Check that this transfer originated from transferRemoteWithAttestation
        if (!pendingAttestation) {
            revert PredicateCrossCollateralRouterWrapper__UnauthorizedTransfer();
        }

        // Clear the flag
        pendingAttestation = false;
    }

    /**
     * @notice Quote returns 0 - this hook has no fee
     * @dev The actual gas fees are paid through the cross-collateral router's IGP hook
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
            revert PredicateCrossCollateralRouterWrapper__InvalidPolicy();

        _setPolicyID(_policyID);
    }

    /**
     * @notice Updates the Predicate registry address
     * @dev Implements IPredicateClient.setRegistry
     * @param _registry The new registry address
     */
    function setRegistry(address _registry) external onlyOwner {
        if (_registry == address(0))
            revert PredicateCrossCollateralRouterWrapper__InvalidRegistry();

        _setRegistry(_registry);
    }

    // ============ ETH Refund Handling ============

    /**
     * @notice Accepts ETH refunds from the cross-collateral router's hook
     * @dev The router sets msg.sender (this wrapper) as refund address.
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
        if (!success)
            revert PredicateCrossCollateralRouterWrapper__WithdrawFailed();
    }
}
