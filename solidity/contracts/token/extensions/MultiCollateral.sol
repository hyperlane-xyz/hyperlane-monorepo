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
import {HypERC20Collateral} from "../HypERC20Collateral.sol";
import {TokenMessage} from "../libs/TokenMessage.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {IPostDispatchHook} from "../../interfaces/hooks/IPostDispatchHook.sol";
import {Quote} from "../../interfaces/ITokenBridge.sol";

/**
 * @title MultiCollateral
 * @notice Multi-router collateral: direct 1-message atomic transfers between
 * collateral routers, both cross-chain and same-chain.
 * @dev Extends HypERC20Collateral. Each deployed instance holds collateral for
 * one ERC20. Enrolled routers are other MultiCollateral instances (same or
 * different token) that this instance trusts to send/receive transfers.
 *
 * Overrides:
 *  - handle(): accepts messages from enrolled remote routers OR enrolled routers
 *    (overrides Router.handle which only accepts enrolled routers)
 */
contract MultiCollateral is HypERC20Collateral {
    using TypeCasts for address;
    using TypeCasts for bytes32;

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
        uint256 _scale,
        address _mailbox
    ) HypERC20Collateral(erc20, _scale, _mailbox) {}

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
            }
            emit RouterEnrolled(_domains[i], _routers[i]);
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
            }
            emit RouterUnenrolled(_domains[i], _routers[i]);
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

    /// @dev Accepts messages from enrolled remote routers OR enrolled routers.
    /// Overrides Router.handle() which only accepts enrolled remote routers.
    // solhint-disable-next-line hyperlane/no-virtual-override
    function handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _message
    ) external payable override onlyMailbox {
        require(
            _isRemoteRouter(_origin, _sender) ||
                enrolledRouters[_origin][_sender],
            "MC: unauthorized router"
        );
        _handle(_origin, _sender, _message);
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

        (, uint256 remainingValue) = _calculateFeesAndCharge(
            _destination,
            _recipient,
            _amount,
            msg.value
        );

        uint256 scaled = _outboundAmount(_amount);
        bytes memory tokenMsg = TokenMessage.format(_recipient, scaled);

        emit SentTransferRemote(_destination, _recipient, scaled);

        messageId = mailbox.dispatch{value: remainingValue}(
            _destination,
            _targetRouter,
            tokenMsg,
            _GasRouter_hookMetadata(_destination),
            IPostDispatchHook(address(hook))
        );
    }

    // ============ Same-chain Local Transfer ============

    /**
     * @notice Transfer tokens locally to an enrolled router on the same chain.
     * @param _targetRouter Address of the local enrolled router.
     * @param _recipient Final token recipient.
     * @param _amount Amount in local token decimals (before fees).
     */
    function localTransferTo(
        address _targetRouter,
        address _recipient,
        uint256 _amount
    ) external {
        require(
            enrolledRouters[localDomain][_targetRouter.addressToBytes32()],
            "MC: not local router"
        );

        (address feeRecip, uint256 fee) = _feeRecipientAndAmount(
            localDomain,
            _recipient.addressToBytes32(),
            _amount
        );

        _transferFromSender(_amount + fee);
        if (fee > 0) _transferFee(feeRecip, fee);

        uint256 canonical = _outboundAmount(_amount);
        MultiCollateral(_targetRouter).receiveLocalSwap(canonical, _recipient);
    }

    /**
     * @notice Called by a local enrolled router to release collateral.
     * @param _canonicalAmount Amount in canonical (18-decimal) representation.
     * @param _recipient Final token recipient.
     */
    function receiveLocalSwap(
        uint256 _canonicalAmount,
        address _recipient
    ) external {
        require(
            enrolledRouters[localDomain][msg.sender.addressToBytes32()],
            "MC: not local router"
        );
        _transferTo(_recipient, _inboundAmount(_canonicalAmount));
    }

    // ============ Quoting ============

    /**
     * @notice Quote fees for transferRemoteTo.
     * @return quotes [0] native gas, [1] token amount + fee, [2] external fee.
     */
    function quoteTransferRemoteTo(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        bytes32 _targetRouter
    ) external view returns (Quote[] memory quotes) {
        quotes = new Quote[](3);

        bytes memory tokenMsg = TokenMessage.format(
            _recipient,
            _outboundAmount(_amount)
        );
        quotes[0] = Quote({
            token: address(0),
            amount: mailbox.quoteDispatch(
                _destination,
                _targetRouter,
                tokenMsg,
                _GasRouter_hookMetadata(_destination),
                IPostDispatchHook(address(hook))
            )
        });

        (, uint256 feeAmount) = _feeRecipientAndAmount(
            _destination,
            _recipient,
            _amount
        );
        quotes[1] = Quote({token: token(), amount: _amount + feeAmount});

        quotes[2] = Quote({
            token: token(),
            amount: _externalFeeAmount(_destination, _recipient, _amount)
        });
    }
}
