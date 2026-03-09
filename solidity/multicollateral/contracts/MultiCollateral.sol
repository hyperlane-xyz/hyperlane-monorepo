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
import {HypERC20Collateral} from "@hyperlane-xyz/core/token/HypERC20Collateral.sol";
import {TokenMessage} from "@hyperlane-xyz/core/token/libs/TokenMessage.sol";
import {TypeCasts} from "@hyperlane-xyz/core/libs/TypeCasts.sol";
import {IPostDispatchHook} from "@hyperlane-xyz/core/interfaces/hooks/IPostDispatchHook.sol";
import {Quote} from "@hyperlane-xyz/core/interfaces/ITokenBridge.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

// ============ Local Imports ============
import {IMultiCollateralFee} from "./interfaces/IMultiCollateralFee.sol";

/**
 * @title MultiCollateral
 * @notice Multi-router collateral: direct 1-message atomic transfers between
 * collateral routers, both cross-chain and same-chain.
 * @dev Extends HypERC20Collateral. Each deployed instance holds collateral for
 * one ERC20. Enrolled routers are other MultiCollateral instances (same or
 * different token) that this instance trusts to send/receive transfers.
 *
 * Overrides:
 *  - handle(): accepts messages from the mailbox (cross-chain) or directly
 *    from enrolled routers on the same chain.
 */
contract MultiCollateral is HypERC20Collateral, IMultiCollateralFee {
    using TypeCasts for address;
    using TypeCasts for bytes32;
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.Bytes32Set;

    // ============ Events ============

    event RouterEnrolled(uint32 indexed domain, bytes32 indexed router);
    event RouterUnenrolled(uint32 indexed domain, bytes32 indexed router);

    // ============ Storage ============

    /// @notice Additional enrolled routers by domain (beyond the standard
    /// enrolled remote router). Local routers use localDomain as key.
    mapping(uint32 => EnumerableSet.Bytes32Set) private _enrolledRouters;

    // ============ Constructor ============

    constructor(
        address erc20,
        uint256 _scaleNumerator,
        uint256 _scaleDenominator,
        address _mailbox
    ) HypERC20Collateral(erc20, _scaleNumerator, _scaleDenominator, _mailbox) {}

    // ============ Router Management (onlyOwner) ============

    function enrollRouters(
        uint32[] calldata _domains,
        bytes32[] calldata _routers
    ) external onlyOwner {
        require(_domains.length == _routers.length, "MC: length mismatch");
        for (uint256 i = 0; i < _domains.length; i++) {
            if (_enrolledRouters[_domains[i]].add(_routers[i])) {
                emit RouterEnrolled(_domains[i], _routers[i]);
            }
        }
    }

    function unenrollRouters(
        uint32[] calldata _domains,
        bytes32[] calldata _routers
    ) external onlyOwner {
        require(_domains.length == _routers.length, "MC: length mismatch");
        for (uint256 i = 0; i < _domains.length; i++) {
            if (_enrolledRouters[_domains[i]].remove(_routers[i])) {
                emit RouterUnenrolled(_domains[i], _routers[i]);
            }
        }
    }

    function enrolledRouters(
        uint32 _domain,
        bytes32 _router
    ) external view returns (bool) {
        return _enrolledRouters[_domain].contains(_router);
    }

    // ============ Enumeration ============

    function getEnrolledRouters(
        uint32 _domain
    ) external view returns (bytes32[] memory) {
        return _enrolledRouters[_domain].values();
    }

    // ============ Destination Gas Override ============

    /// @notice Sets destination gas for a domain that has either a default remote
    /// router or MC-enrolled routers. Bypasses GasRouter._setDestinationGas which
    /// only checks the default Router._routers map.
    /// @dev Excludes localDomain since same-chain transfers skip mailbox dispatch.
    function setDestinationGasForDomain(
        uint32 domain,
        uint256 gas
    ) external onlyOwner {
        require(domain != localDomain, "MC: no gas for local domain");
        require(
            routers(domain) != bytes32(0) ||
                _enrolledRouters[domain].length() > 0,
            "MC: domain has no routers"
        );
        destinationGas[domain] = gas;
        emit GasSet(domain, gas);
    }

    /// @notice Batch version of setDestinationGasForDomain.
    function setDestinationGasForDomains(
        GasRouterConfig[] calldata gasConfigs
    ) external onlyOwner {
        for (uint256 i = 0; i < gasConfigs.length; i++) {
            uint32 domain = gasConfigs[i].domain;
            require(domain != localDomain, "MC: no gas for local domain");
            require(
                routers(domain) != bytes32(0) ||
                    _enrolledRouters[domain].length() > 0,
                "MC: domain has no routers"
            );
            destinationGas[domain] = gasConfigs[i].gas;
            emit GasSet(domain, gasConfigs[i].gas);
        }
    }

    // ============ Internal Helpers ============

    /// @dev Reverts unless `_router` is enrolled for `_domain` (either via the
    /// standard Router._routers map or via the MC-specific _enrolledRouters set).
    function _requireAuthorizedRouter(
        uint32 _domain,
        bytes32 _router
    ) internal view {
        require(
            _isRemoteRouter(_domain, _router) ||
                _enrolledRouters[_domain].contains(_router),
            "MC: unauthorized router"
        );
    }

    // ============ Handle Override ============

    /// @dev Overrides `Router.handle` from core (`client/Router.sol`) via
    /// HypERC20Collateral -> TokenRouter -> GasRouter -> Router.
    /// Accepts messages from the mailbox (cross-chain) or directly from
    /// enrolled routers on the same chain. Removes the onlyMailbox modifier.
    // solhint-disable-next-line hyperlane/no-virtual-override
    function handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _message
    ) external payable override {
        if (msg.sender == address(mailbox)) {
            // Cross-chain via mailbox: sender must be enrolled
            _requireAuthorizedRouter(_origin, _sender);
        } else {
            // Same-chain direct call: caller must be an enrolled router
            require(
                _enrolledRouters[localDomain].contains(
                    TypeCasts.addressToBytes32(msg.sender)
                ),
                "MC: unauthorized router"
            );
        }
        _handle(_origin, _sender, _message);
    }

    // ============ Per-Router Fee Lookup ============
    // Mirrors TokenRouter._feeRecipientAndAmount but routes through
    // IMultiCollateralFee.quoteTransferRemoteTo (which includes _targetRouter)
    // instead of ITokenFee.quoteTransferRemote (destination-only).

    function _feeRecipientAndAmountForRouter(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        bytes32 _targetRouter
    ) internal view returns (address _feeRecipient, uint256 feeAmount) {
        _feeRecipient = feeRecipient();
        if (_feeRecipient == address(0)) return (_feeRecipient, 0);

        // Only difference from base: quoteTransferRemoteTo with _targetRouter
        Quote[] memory quotes = IMultiCollateralFee(_feeRecipient)
            .quoteTransferRemoteTo(
                _destination,
                _recipient,
                _amount,
                _targetRouter
            );
        if (quotes.length == 0) return (_feeRecipient, 0);

        require(
            quotes.length == 1 && quotes[0].token == token(),
            "MC: fee must match token"
        );
        feeAmount = quotes[0].amount;
    }

    // Mirrors TokenRouter._calculateFeesAndCharge. Identical charge/hook/transfer
    // logic — only the fee lookup differs (router-aware via _feeRecipientAndAmountForRouter).
    // Duplicated here because the base hardcodes _feeRecipientAndAmount.
    function _calculateFeesAndChargeForRouter(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        uint256 _msgValue,
        bytes32 _targetRouter
    ) internal returns (uint256 externalFee, uint256 remainingNativeValue) {
        // Only difference from base: router-aware fee lookup
        (
            address _feeRecipient,
            uint256 feeAmount
        ) = _feeRecipientAndAmountForRouter(
                _destination,
                _recipient,
                _amount,
                _targetRouter
            );
        // --- remainder identical to TokenRouter._calculateFeesAndCharge ---
        externalFee = _externalFeeAmount(_destination, _recipient, _amount);
        uint256 charge = _amount + feeAmount + externalFee;

        address _feeHook = feeHook();
        address _token = token();
        address _feeToken = feeToken();

        // Same-domain transferRemoteTo calls handle() directly and does not dispatch
        // through mailbox hooks, so do not charge hook fees in that path.
        if (_feeHook != address(0) && _destination != localDomain) {
            uint256 hookFee = _quoteGasPaymentTo(
                _destination,
                _recipient,
                _outboundAmount(_amount),
                _feeToken,
                _targetRouter
            );
            if (hookFee > 0) {
                if (_token != address(this)) {
                    charge += hookFee;
                } else {
                    IERC20(_token).safeTransferFrom(
                        msg.sender,
                        address(this),
                        hookFee
                    );
                }
                IERC20(_token).forceApprove(_feeHook, hookFee);
            }
        }

        _transferFromSender(charge);
        if (feeAmount > 0) {
            _transferFee(_feeRecipient, feeAmount);
        }
        remainingNativeValue = _token != address(0)
            ? _msgValue
            : _msgValue - charge;
    }

    // ============ Cross-chain Transfer to Specific Router ============

    /**
     * @notice Transfers tokens to the primary enrolled router for `_destination`.
     * @dev Uses the enrolled primary remote router for `_destination` and routes through
     * router-aware fee lookup (`IMultiCollateralFee`) via `transferRemoteTo`.
     * @dev This override is required because TokenRouter's `_feeRecipientAndAmount`
     * is non-virtual and hardcodes `ITokenFee`. Delegating through
     * `transferRemoteTo` keeps both transfer paths on `IMultiCollateralFee`.
     */
    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) public payable override returns (bytes32 messageId) {
        bytes32 targetRouter = _mustHaveRemoteRouter(_destination);
        return
            transferRemoteTo(_destination, _recipient, _amount, targetRouter);
    }

    /**
     * @notice Transfer tokens cross-chain to a specific target router.
     * @dev Follows TokenRouter.transferRemote() flow: fees → message → emit → dispatch.
     * Bypasses _Router_dispatch (which hardcodes the enrolled router) to dispatch
     * directly to the target router.
     * @param _destination Destination domain.
     * @param _recipient Final token recipient on destination.
     * @param _amount Amount in local token decimals.
     * @param _targetRouter The enrolled router to receive the message on destination.
     * @return messageId The dispatched message ID.
     */
    function transferRemoteTo(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        bytes32 _targetRouter
    ) public payable returns (bytes32 messageId) {
        _requireAuthorizedRouter(_destination, _targetRouter);
        if (_destination == localDomain) {
            require(msg.value == 0, "MC: local transfer no msg.value");
        }

        (, uint256 remainingValue) = _calculateFeesAndChargeForRouter(
            _destination,
            _recipient,
            _amount,
            msg.value,
            _targetRouter
        );

        uint256 scaled = _outboundAmount(_amount);
        bytes memory tokenMsg = TokenMessage.format(_recipient, scaled);

        if (_destination == localDomain) {
            // Same-domain: call target router's handle directly
            address target = _targetRouter.bytes32ToAddress();
            require(target.code.length > 0, "MC: target router not contract");
            MultiCollateral(target).handle(
                localDomain,
                TypeCasts.addressToBytes32(address(this)),
                tokenMsg
            );
        } else {
            emit SentTransferRemote(_destination, _recipient, scaled);
            messageId = mailbox.dispatch{value: remainingValue}(
                _destination,
                _targetRouter,
                tokenMsg,
                _generateHookMetadata(_destination, feeToken()),
                IPostDispatchHook(address(hook))
            );
        }
    }

    // ============ Quoting ============

    // Mirrors TokenRouter.quoteTransferRemote. Same 3-element quote structure.
    // Differences: (1) router-aware fee lookup, (2) same-domain returns 0 gas
    // since handle() is called directly without mailbox dispatch.

    /// @inheritdoc IMultiCollateralFee
    function quoteTransferRemoteTo(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        bytes32 _targetRouter
    ) external view override returns (Quote[] memory quotes) {
        _requireAuthorizedRouter(_destination, _targetRouter);
        if (_destination == localDomain) {
            require(
                _targetRouter.bytes32ToAddress().code.length > 0,
                "MC: target router not contract"
            );
        }

        quotes = new Quote[](3);

        // Same-domain: handle() called directly, no interchain gas
        uint256 gasQuote = 0;
        address _feeToken = feeToken();
        if (_destination != localDomain) {
            gasQuote = _quoteGasPaymentTo(
                _destination,
                _recipient,
                _outboundAmount(_amount),
                _feeToken,
                _targetRouter
            );
        }
        quotes[0] = Quote({token: _feeToken, amount: gasQuote});

        // Only difference from base: router-aware fee lookup
        (, uint256 feeAmount) = _feeRecipientAndAmountForRouter(
            _destination,
            _recipient,
            _amount,
            _targetRouter
        );
        quotes[1] = Quote({token: token(), amount: _amount + feeAmount});

        quotes[2] = Quote({
            token: token(),
            amount: _externalFeeAmount(_destination, _recipient, _amount)
        });
    }

    /// @dev Target-router-aware gas quote helper. Avoids Router._mustHaveRemoteRouter().
    /// Caller must validate `_targetRouter` is authorized for `_destination`.
    function _quoteGasPaymentTo(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        address _feeToken,
        bytes32 _targetRouter
    ) internal view returns (uint256) {
        return
            mailbox.quoteDispatch(
                _destination,
                _targetRouter,
                TokenMessage.format(_recipient, _amount),
                _generateHookMetadata(_destination, _feeToken),
                IPostDispatchHook(address(hook))
            );
    }
}
