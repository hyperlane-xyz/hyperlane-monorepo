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
import {Quote} from "../../interfaces/ITokenBridge.sol";
import {IPredicateWrapper} from "../../interfaces/IPredicateWrapper.sol";
import {AbstractPredicateWrapper} from "../libs/AbstractPredicateWrapper.sol";

// ============ Predicate Imports ============
import {Attestation} from "@predicate/interfaces/IPredicateRegistry.sol";

// ============ Local Imports ============
import {CrossCollateralRouter} from "../CrossCollateralRouter.sol";
import {ICrossCollateralFee} from "../interfaces/ICrossCollateralFee.sol";

/**
 * @title PredicateCrossCollateralRouterWrapper
 * @author Abacus Works
 * @notice Wraps an existing CrossCollateralRouter with Predicate attestation validation.
 *         Acts as BOTH a user entry point AND a post-dispatch hook.
 * @dev Security model:
 *      1. User calls transferRemoteWithAttestation() or transferRemoteToWithAttestation()
 *      2. Wrapper validates attestation via PredicateClient, sets pendingAttestation = true
 *      3. Wrapper calls router.transferRemote() or transferRemoteTo()
 *      4. For cross-domain: CrossCollateralRouter dispatches message, mailbox calls postDispatch()
 *      5. For same-domain: CrossCollateralRouter calls handle() directly, no postDispatch
 *      6. postDispatch() verifies pendingAttestation == true (cross-domain only), then clears it
 *
 *      If someone bypasses wrapper and calls the router directly, postDispatch()
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
    AbstractPredicateWrapper,
    ICrossCollateralFee
{
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

    constructor(
        address _crossCollateralRouter,
        address _registry,
        string memory _policyID
    ) AbstractPredicateWrapper(_crossCollateralRouter, _registry, _policyID) {
        // CrossCollateralRouter always has a non-zero token (native not supported)
        if (address(token) == address(0))
            revert IPredicateWrapper
                .PredicateRouterWrapper__NativeTokenUnsupported();
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
        CrossCollateralRouter ccr = CrossCollateralRouter(address(router));

        bytes memory encodedSigAndArgs = abi.encodeWithSelector(
            CrossCollateralRouter.transferRemoteTo.selector,
            _destination,
            _recipient,
            _amount,
            _targetRouter
        );

        Quote[] memory quotes = ccr.quoteTransferRemoteTo(
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
                quotes,
                _destination != localDomain
            );
    }

    // ========== ICrossCollateralFee Implementation ==========

    /**
     * @notice Quotes the fees to a specific target router by delegating to the underlying
     * cross collateral route
     */
    function quoteTransferRemoteTo(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        bytes32 _targetRouter
    ) external view override returns (Quote[] memory quotes) {
        return
            CrossCollateralRouter(address(router)).quoteTransferRemoteTo(
                _destination,
                _recipient,
                _amount,
                _targetRouter
            );
    }

    // ============ Internal Overrides ============

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
}
