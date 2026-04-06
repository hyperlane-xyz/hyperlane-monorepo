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
import {ITokenBridge, ITokenFee, Quote} from "../../interfaces/ITokenBridge.sol";
import {IPredicateWrapper} from "../../interfaces/IPredicateWrapper.sol";
import {Quotes} from "./Quotes.sol";
import {TokenRouter} from "./TokenRouter.sol";

import {PredicateClient} from "@predicate/mixins/PredicateClient.sol";
import {Attestation} from "@predicate/interfaces/IPredicateRegistry.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
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
    Ownable,
    IPredicateWrapper,
    ITokenFee
{
    using Quotes for Quote[];
    using SafeERC20 for IERC20;

    // ============ Constants ============

    uint8 public constant override hookType =
        uint8(IPostDispatchHook.HookTypes.PREDICATE_ROUTER_WRAPPER);

    // ============ Immutables ============

    /// @notice The underlying router being wrapped
    TokenRouter public immutable router;

    /// @notice The ERC20 token managed by the router
    IERC20 public immutable token;

    /// @notice The local domain ID (cached from router during construction)
    uint32 public immutable localDomain;

    // ============ Storage ============

    /// @notice Flag set before calling the router, checked in postDispatch
    /// @dev Key bypass-prevention: if false in postDispatch, transfer was unauthorized
    bool public pendingAttestation;

    // ============ Constructor ============

    constructor(address _router, address _registry, string memory _policyID) {
        if (_router == address(0))
            revert IPredicateWrapper.PredicateRouterWrapper__InvalidRouter();
        if (_registry == address(0))
            revert IPredicateWrapper.PredicateRouterWrapper__InvalidRegistry();
        if (bytes(_policyID).length == 0)
            revert IPredicateWrapper.PredicateRouterWrapper__InvalidPolicy();

        router = TokenRouter(_router);
        address tokenAddress = router.token();
        token = IERC20(tokenAddress);
        localDomain = router.localDomain();

        _initPredicateClient(_registry, _policyID);

        // Infinite approval to router for token transfers (skip for native)
        if (tokenAddress != address(0)) {
            IERC20(tokenAddress).forceApprove(_router, type(uint256).max);
        }
    }

    function _pullTokens(
        Quote[] memory quotes
    ) internal virtual returns (uint256 totalNativeRequired) {
        totalNativeRequired = Quotes.extract(quotes, address(0));
        if (msg.value < totalNativeRequired)
            revert IPredicateWrapper
                .PredicateRouterWrapper__InsufficientValue();

        if (address(token) == address(0)) return totalNativeRequired;
        uint256 totalTokenRequired = Quotes.extract(quotes, address(token));
        if (totalTokenRequired > 0) {
            token.safeTransferFrom(
                msg.sender,
                address(this),
                totalTokenRequired
            );
        }
    }

    /// @notice Emits the TransferAuthorized event. Subclasses implement.
    function _emitTransferAuthorized(
        address sender,
        uint32 destination,
        bytes32 recipient,
        uint256 amount,
        string calldata uuid
    ) internal virtual;

    // ============ External Functions ============

    /**
     * @notice Quotes the fees for a remote transfer by delegating to the underlying router
     */
    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external view override returns (Quote[] memory quotes) {
        return router.quoteTransferRemote(_destination, _recipient, _amount);
    }

    /**
     * @notice Transfer tokens with Predicate attestation validation
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
    ) external payable virtual returns (bytes32 messageId) {
        bytes memory encodedSigAndArgs = abi.encodeWithSelector(
            ITokenBridge.transferRemote.selector,
            _destination,
            _recipient,
            _amount
        );

        Quote[] memory quotes = router.quoteTransferRemote(
            _destination,
            _recipient,
            _amount
        );

        _emitTransferAuthorized(
            msg.sender,
            _destination,
            _recipient,
            _amount,
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

    /**
     * @notice Template: authorize → check value → pull tokens → call router → refund.
     * @param _attestation  Predicate attestation
     * @param encodedSigAndArgs  ABI-encoded selector + arguments for the router call
     * @param quotes  Fee quotes returned by the router's quote function
     * @param isCrossDomain  Whether this is a cross-domain transfer requiring authorization
     *        and hook bypass prevention (false for same-domain CCR where postDispatch is
     *        never called, making attestation enforcement unenforceable via the wrapper)
     * @return messageId  Decoded from the router's return data
     */
    function _executeAttested(
        Attestation calldata _attestation,
        bytes memory encodedSigAndArgs,
        Quote[] memory quotes,
        bool isCrossDomain
    ) internal returns (bytes32 messageId) {
        if (isCrossDomain) {
            if (pendingAttestation)
                revert IPredicateWrapper
                    .PredicateRouterWrapper__ReentryDetected();

            if (
                !_authorizeTransaction(
                    _attestation,
                    encodedSigAndArgs,
                    msg.sender,
                    msg.value
                )
            )
                revert IPredicateWrapper
                    .PredicateRouterWrapper__AttestationInvalid();

            pendingAttestation = true;
        }

        uint256 totalNativeRequired = _pullTokens(quotes);

        (bool success, bytes memory returnData) = address(router).call{
            value: totalNativeRequired
        }(encodedSigAndArgs);

        if (!success) {
            assembly {
                revert(add(returnData, 32), mload(returnData))
            }
        }

        if (isCrossDomain && pendingAttestation)
            revert IPredicateWrapper
                .PredicateRouterWrapper__PostDispatchNotExecuted();

        uint256 excess = msg.value - totalNativeRequired;
        if (excess > 0) {
            (bool refundSuccess, ) = msg.sender.call{value: excess}("");
            if (!refundSuccess)
                revert IPredicateWrapper.PredicateRouterWrapper__RefundFailed();
        }

        return abi.decode(returnData, (bytes32));
    }

    // ============ Hook Implementation ============

    /// @notice Verifies transfer originated from an attested wrapper call
    function _postDispatch(bytes calldata, bytes calldata) internal override {
        if (!pendingAttestation)
            revert IPredicateWrapper
                .PredicateRouterWrapper__UnauthorizedTransfer();
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
            revert IPredicateWrapper.PredicateRouterWrapper__InvalidPolicy();
        _setPolicyID(_policyID);
    }

    /// @notice Updates the Predicate registry address
    function setRegistry(address _registry) external onlyOwner {
        if (_registry == address(0))
            revert IPredicateWrapper.PredicateRouterWrapper__InvalidRegistry();
        _setRegistry(_registry);
    }

    // ============ ETH Handling ============

    /// @notice Accepts ETH refunds from the router's hook
    receive() external payable {}

    /// @notice Withdraws trapped ETH to owner
    function withdrawETH() external onlyOwner {
        uint256 balance = address(this).balance;
        (bool success, ) = msg.sender.call{value: balance}("");
        if (!success)
            revert IPredicateWrapper.PredicateRouterWrapper__WithdrawFailed();
    }
}
