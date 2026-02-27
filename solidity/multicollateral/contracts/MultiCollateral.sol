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

    // ============ Events ============

    event RouterEnrolled(uint32 indexed domain, bytes32 indexed router);
    event RouterUnenrolled(uint32 indexed domain, bytes32 indexed router);

    // ============ Storage ============

    /// @notice Additional enrolled routers by domain (beyond the standard
    /// enrolled remote router). Local routers use localDomain as key.
    mapping(uint32 domain => mapping(bytes32 router => bool))
        public enrolledRouters;

    /// @notice Enumerable list of enrolled routers per domain.
    mapping(uint32 => bytes32[]) internal _enrolledRouterList;

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
            if (!enrolledRouters[_domains[i]][_routers[i]]) {
                enrolledRouters[_domains[i]][_routers[i]] = true;
                _enrolledRouterList[_domains[i]].push(_routers[i]);
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
            if (enrolledRouters[_domains[i]][_routers[i]]) {
                enrolledRouters[_domains[i]][_routers[i]] = false;
                _removeFromList(_domains[i], _routers[i]);
                emit RouterUnenrolled(_domains[i], _routers[i]);
            }
        }
    }

    // ============ Enumeration ============

    function getEnrolledRouters(
        uint32 _domain
    ) external view returns (bytes32[] memory) {
        return _enrolledRouterList[_domain];
    }

    // ============ Internal ============

    function _removeFromList(uint32 _domain, bytes32 _router) internal {
        bytes32[] storage list = _enrolledRouterList[_domain];
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == _router) {
                list[i] = list[list.length - 1];
                list.pop();
                return;
            }
        }
    }

    // ============ Handle Override ============

    /// @dev Accepts messages from the mailbox (cross-chain) or directly from
    /// enrolled routers on the same chain. Removes the onlyMailbox modifier.
    // solhint-disable-next-line hyperlane/no-virtual-override
    function handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _message
    ) external payable override {
        if (msg.sender == address(mailbox)) {
            // Cross-chain via mailbox: sender must be enrolled
            require(
                _isRemoteRouter(_origin, _sender) ||
                    enrolledRouters[_origin][_sender],
                "MC: unauthorized router"
            );
        } else {
            // Same-chain direct call: caller must be an enrolled router
            require(
                enrolledRouters[localDomain][
                    TypeCasts.addressToBytes32(msg.sender)
                ],
                "MC: unauthorized router"
            );
        }
        _handle(_origin, _sender, _message);
    }

    // ============ Per-Router Fee Lookup ============

    function _feeRecipientAndAmountForRouter(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        bytes32 _targetRouter
    ) internal view returns (address _feeRecipient, uint256 feeAmount) {
        _feeRecipient = feeRecipient();
        if (_feeRecipient == address(0)) return (_feeRecipient, 0);

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

    function _calculateFeesAndChargeForRouter(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        uint256 _msgValue,
        bytes32 _targetRouter
    ) internal returns (uint256 externalFee, uint256 remainingNativeValue) {
        (
            address _feeRecipient,
            uint256 feeAmount
        ) = _feeRecipientAndAmountForRouter(
                _destination,
                _recipient,
                _amount,
                _targetRouter
            );
        externalFee = _externalFeeAmount(_destination, _recipient, _amount);
        uint256 charge = _amount + feeAmount + externalFee;

        address _feeHook = feeHook();
        address _token = token();

        // ERC20 fee hook: use token() for gas payments
        if (_feeHook != address(0)) {
            uint256 hookFee = _quoteGasPayment(
                _destination,
                _recipient,
                _amount,
                _token
            );
            if (_token != address(this)) {
                charge += hookFee;
            } else {
                IERC20(_token).safeTransferFrom(
                    msg.sender,
                    address(this),
                    hookFee
                );
            }
            IERC20(_token).approve(_feeHook, hookFee);
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
        require(
            _isRemoteRouter(_destination, _targetRouter) ||
                enrolledRouters[_destination][_targetRouter],
            "MC: unauthorized router"
        );

        (, uint256 remainingValue) = _calculateFeesAndChargeForRouter(
            _destination,
            _recipient,
            _amount,
            msg.value,
            _targetRouter
        );

        uint256 scaled = _outboundAmount(_amount);
        bytes memory tokenMsg = TokenMessage.format(_recipient, scaled);

        emit SentTransferRemote(_destination, _recipient, scaled);

        if (_destination == localDomain) {
            // Same-domain: call target router's handle directly
            MultiCollateral(_targetRouter.bytes32ToAddress()).handle{
                value: remainingValue
            }(localDomain, TypeCasts.addressToBytes32(address(this)), tokenMsg);
        } else {
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

    /**
     * @notice Quote fees for transferRemoteTo.
     * @return quotes [0] native/feeToken gas, [1] token amount + fee, [2] external fee.
     */
    function quoteTransferRemoteTo(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        bytes32 _targetRouter
    ) external view returns (Quote[] memory quotes) {
        quotes = new Quote[](3);

        // Same-domain: handle() called directly, no interchain gas
        uint256 gasQuote = 0;
        address _feeToken = feeToken();
        if (_destination != localDomain) {
            gasQuote = _quoteGasPayment(
                _destination,
                _recipient,
                _outboundAmount(_amount),
                _feeToken
            );
        }
        quotes[0] = Quote({token: _feeToken, amount: gasQuote});

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
}
