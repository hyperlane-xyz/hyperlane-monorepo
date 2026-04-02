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

import {AbstractPostDispatchHook} from "../../hooks/libs/AbstractPostDispatchHook.sol";
import {IPostDispatchHook} from "../../interfaces/hooks/IPostDispatchHook.sol";
import {Quote} from "../../interfaces/ITokenBridge.sol";
import {Quotes} from "./Quotes.sol";

import {PredicateClient} from "@predicate/mixins/PredicateClient.sol";
import {Attestation} from "@predicate/interfaces/IPredicateRegistry.sol";

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title AbstractPredicateWrapper
 * @author Abacus Works
 * @notice Shared base for Predicate-gated router wrapper contracts.
 *         Provides the pendingAttestation bypass-prevention mechanism,
 *         hook implementation, and admin functions common to all wrappers.
 */
abstract contract AbstractPredicateWrapper is
    AbstractPostDispatchHook,
    PredicateClient,
    Ownable
{
    using Quotes for Quote[];

    // ============ Constants ============

    uint8 public constant override hookType =
        uint8(IPostDispatchHook.HookTypes.PREDICATE_ROUTER_WRAPPER);

    // ============ Storage ============

    /// @notice Flag set before calling the router, checked in postDispatch
    /// @dev Key bypass-prevention: if false in postDispatch, transfer was unauthorized
    bool public pendingAttestation;

    // ============ Errors ============

    error AbstractPredicateWrapper__UnauthorizedTransfer();
    error AbstractPredicateWrapper__InvalidRegistry();
    error AbstractPredicateWrapper__InvalidPolicy();
    error AbstractPredicateWrapper__WithdrawFailed();
    error AbstractPredicateWrapper__AttestationInvalid();
    error AbstractPredicateWrapper__InsufficientValue();
    error AbstractPredicateWrapper__PostDispatchNotExecuted();
    error AbstractPredicateWrapper__RefundFailed();
    error AbstractPredicateWrapper__ReentryDetected();

    // ============ Internal Helpers ============

    /// @notice Validates registry/policy and initializes PredicateClient
    function _initPredicateWrapperBase(
        address _registry,
        string memory _policyID
    ) internal {
        if (_registry == address(0))
            revert AbstractPredicateWrapper__InvalidRegistry();
        if (bytes(_policyID).length == 0)
            revert AbstractPredicateWrapper__InvalidPolicy();
        _initPredicateClient(_registry, _policyID);
    }

    /// @notice Pull the required ERC20 tokens from msg.sender. Subclasses implement.
    function _pullTokens(Quote[] memory quotes) internal virtual;

    /**
     * @notice Template: authorize → check value → pull tokens → call router → refund.
     * @param _attestation  Predicate attestation
     * @param encodedSigAndArgs  ABI-encoded selector + arguments for the router call
     * @param _router  Address of the underlying router to call
     * @param quotes  Fee quotes returned by the router's quote function
     * @param setPending  Whether to set/check pendingAttestation (false for same-domain CCR)
     * @return messageId  Decoded from the router's return data
     */
    function _executeAttested(
        Attestation calldata _attestation,
        bytes memory encodedSigAndArgs,
        address _router,
        Quote[] memory quotes,
        bool setPending
    ) internal returns (bytes32 messageId) {
        if (pendingAttestation)
            revert AbstractPredicateWrapper__ReentryDetected();

        if (
            !_authorizeTransaction(
                _attestation,
                encodedSigAndArgs,
                msg.sender,
                msg.value
            )
        ) revert AbstractPredicateWrapper__AttestationInvalid();

        uint256 totalNativeRequired = Quotes.extract(quotes, address(0));
        if (msg.value < totalNativeRequired)
            revert AbstractPredicateWrapper__InsufficientValue();

        _pullTokens(quotes);

        if (setPending) pendingAttestation = true;

        (bool success, bytes memory returnData) = _router.call{
            value: totalNativeRequired
        }(encodedSigAndArgs);

        if (!success) {
            assembly {
                revert(add(returnData, 32), mload(returnData))
            }
        }

        if (setPending && pendingAttestation)
            revert AbstractPredicateWrapper__PostDispatchNotExecuted();

        uint256 excess = msg.value - totalNativeRequired;
        if (excess > 0) {
            (bool refundSuccess, ) = msg.sender.call{value: excess}("");
            if (!refundSuccess) revert AbstractPredicateWrapper__RefundFailed();
        }

        return abi.decode(returnData, (bytes32));
    }

    // ============ Hook Implementation ============

    /// @notice Verifies transfer originated from an attested wrapper call
    function _postDispatch(bytes calldata, bytes calldata) internal override {
        if (!pendingAttestation)
            revert AbstractPredicateWrapper__UnauthorizedTransfer();
        pendingAttestation = false;
    }

    /// @notice No fee — gas fees are paid via the router's IGP hook
    function _quoteDispatch(
        bytes calldata,
        bytes calldata
    ) internal pure override returns (uint256) {
        return 0;
    }

    // ============ Admin Functions ============

    /// @notice Updates the Predicate policy ID
    function setPolicyID(string memory _policyID) external onlyOwner {
        if (bytes(_policyID).length == 0)
            revert AbstractPredicateWrapper__InvalidPolicy();
        _setPolicyID(_policyID);
    }

    /// @notice Updates the Predicate registry address
    function setRegistry(address _registry) external onlyOwner {
        if (_registry == address(0))
            revert AbstractPredicateWrapper__InvalidRegistry();
        _setRegistry(_registry);
    }

    // ============ ETH Handling ============

    /// @notice Accepts ETH refunds from the router's hook
    receive() external payable {}

    /// @notice Withdraws trapped ETH to owner
    function withdrawETH() external onlyOwner {
        uint256 balance = address(this).balance;
        (bool success, ) = msg.sender.call{value: balance}("");
        if (!success) revert AbstractPredicateWrapper__WithdrawFailed();
    }
}
