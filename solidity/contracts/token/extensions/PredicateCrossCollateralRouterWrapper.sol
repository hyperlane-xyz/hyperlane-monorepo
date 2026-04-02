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
import {ITokenBridge, Quote} from "../../interfaces/ITokenBridge.sol";
import {AbstractPredicateWrapper} from "../libs/AbstractPredicateWrapper.sol";
import {Quotes} from "../libs/Quotes.sol";

// ============ Predicate Imports ============
import {Attestation} from "@predicate/interfaces/IPredicateRegistry.sol";

// ============ External Imports ============
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

// ============ Local Imports ============
import {CrossCollateralRouter} from "../CrossCollateralRouter.sol";

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
contract PredicateCrossCollateralRouterWrapper is AbstractPredicateWrapper {
    using SafeERC20 for IERC20;

    // ============ Immutables ============

    /// @notice The underlying CrossCollateralRouter being wrapped
    CrossCollateralRouter public immutable crossCollateralRouter;

    /// @notice The ERC20 token managed by the cross-collateral router
    IERC20 public immutable token;

    /// @notice The local domain ID (cached from router during construction)
    uint32 public immutable localDomain;

    // ============ Errors ============

    error PredicateCrossCollateralRouterWrapper__InvalidRouter();

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

        crossCollateralRouter = CrossCollateralRouter(_crossCollateralRouter);
        address tokenAddress = crossCollateralRouter.token();
        token = IERC20(tokenAddress);
        localDomain = crossCollateralRouter.localDomain();

        _initPredicateWrapperBase(_registry, _policyID);

        // Infinite approval to cross-collateral router for token transfers
        token.forceApprove(_crossCollateralRouter, type(uint256).max);
    }

    // ============ External Functions ============

    /**
     * @notice Transfer tokens to specific target router with Predicate attestation validation
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
        bytes memory encodedSigAndArgs = abi.encodeWithSelector(
            CrossCollateralRouter.transferRemoteTo.selector,
            _destination,
            _recipient,
            _amount,
            _targetRouter
        );

        Quote[] memory quotes = crossCollateralRouter.quoteTransferRemoteTo(
            _destination,
            _recipient,
            _amount,
            _targetRouter
        );

        emit TransferAuthorized(
            msg.sender,
            _destination,
            _recipient,
            _amount,
            _targetRouter,
            _attestation.uuid
        );

        return
            _executeAttested(
                _attestation,
                encodedSigAndArgs,
                address(crossCollateralRouter),
                quotes,
                _destination != localDomain
            );
    }

    // ============ Internal Overrides ============

    function _transferRouter() internal view override returns (ITokenBridge) {
        return ITokenBridge(address(crossCollateralRouter));
    }

    function _isCrossDomain(
        uint32 destination
    ) internal view override returns (bool) {
        return destination != localDomain;
    }

    function _emitTransferAuthorized(
        address sender,
        uint32 destination,
        bytes32 recipient,
        uint256 amount,
        string calldata uuid
    ) internal override {
        emit TransferAuthorized(
            sender,
            destination,
            recipient,
            amount,
            bytes32(0),
            uuid
        );
    }

    function _pullTokens(Quote[] memory quotes) internal override {
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
