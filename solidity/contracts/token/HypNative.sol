// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {GasRouter} from "../client/GasRouter.sol";
import {Quote, ITokenBridge} from "../interfaces/ITokenBridge.sol";
import {TokenMessage} from "./libs/TokenMessage.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {DecimalScaleable} from "./libs/mixins/DecimalScaleable.sol";
import {FeeChargeable} from "./libs/mixins/FeeChargeable.sol";

import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title Hyperlane Native Token Router that extends ERC20 with remote transfer functionality.
 * @author Abacus Works
 * @dev Supply on each chain is not constant but the aggregate supply across all chains is.
 */
contract HypNative is GasRouter, ITokenBridge {
    using Address for address;
    using TypeCasts for bytes32;
    using TypeCasts for address;
    using TokenMessage for bytes;

    uint256 public immutable scale;

    constructor(uint256 _scale, address _mailbox) GasRouter(_mailbox) {
        scale = _scale;
    }

    /**
     * @notice Initializes the Hyperlane router
     * @param _hook The post-dispatch hook contract.
     * @param _interchainSecurityModule The interchain security module contract.
     * @param _owner The this contract.
     */
    function initialize(
        address _hook,
        address _interchainSecurityModule,
        address _owner
    ) public virtual initializer {
        _MailboxClient_initialize(_hook, _interchainSecurityModule, _owner);
    }

    function token() public view virtual override returns (address) {
        return address(0);
    }

    // ============ Quote Functions ============

    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external view virtual override returns (Quote[3] memory quotes) {
        uint256 scaledAmount = DecimalScaleable.scaleOutbound(_amount, scale);
        bytes memory message = TokenMessage.format(_recipient, scaledAmount);
        uint256 dispatchValue = _GasRouter_quoteDispatch(_destination, message);
        quotes[0] = Quote({token: address(0), amount: dispatchValue});
        quotes[1] = Quote({token: address(0), amount: _amount});
        uint256 fee = FeeChargeable.calculateFeeAmount(
            address(0),
            _destination,
            _recipient,
            _amount
        );
        quotes[2] = Quote({token: address(0), amount: fee});
        return quotes;
    }

    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external payable virtual returns (bytes32 messageId) {
        uint256 fee = FeeChargeable.calculateFeeAmount(
            address(0),
            _destination,
            _recipient,
            _amount
        );
        require(msg.value >= _amount + fee);
        if (fee > 0) {
            payable(FeeChargeable.getFeeRecipient()).sendValue(fee);
        }
        uint256 dispatchValue = msg.value - (_amount + fee);

        uint256 scaledAmount = DecimalScaleable.scaleOutbound(_amount, scale);
        emit SentTransferRemote(_destination, _recipient, scaledAmount);

        bytes memory message = TokenMessage.format(_recipient, scaledAmount);

        return _GasRouter_dispatch(_destination, dispatchValue, message);
    }

    function _handle(
        uint32 _origin,
        bytes32,
        bytes calldata _message
    ) internal virtual override {
        bytes32 recipient = _message.recipient();
        uint256 amount = _message.amount();

        emit ReceivedTransferRemote(_origin, recipient, amount);

        uint256 scaledAmount = DecimalScaleable.scaleInbound(amount, scale);
        payable(recipient.bytes32ToAddress()).sendValue(scaledAmount);
    }
}
