// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {TokenRouter} from "./libs/TokenRouter.sol";
import {LpCollateralRouter} from "./libs/LpCollateralRouter.sol";
import {Quote, ITokenBridge} from "../interfaces/ITokenBridge.sol";

import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {TokenMessage} from "./libs/TokenMessage.sol";

/**
 * @title Hyperlane Native Token Router that extends ERC20 with remote transfer functionality.
 * @author Abacus Works
 * @dev Supply on each chain is not constant but the aggregate supply across all chains is.
 */
contract HypNative is LpCollateralRouter {
    using TokenMessage for bytes;

    string internal constant INSUFFICIENT_NATIVE_AMOUNT =
        "Native: amount exceeds msg.value";

    constructor(
        uint256 _scale,
        address _mailbox
    ) TokenRouter(_scale, _mailbox) {}

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
        _LpCollateralRouter_initialize();
    }

    // override for single unified quote
    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external view virtual override returns (Quote[] memory quotes) {
        quotes = new Quote[](1);
        quotes[0] = Quote({
            token: address(0),
            amount: _quoteGasPayment(_destination, _recipient, _amount) +
                _feeAmount(_destination, _recipient, _amount) +
                _amount
        });
    }

    function token() public view virtual override returns (address) {
        return address(0);
    }

    /**
     * @inheritdoc TokenRouter
     */
    function _transferFromSender(uint256 _amount) internal virtual override {
        require(msg.value >= _amount, "Native: amount exceeds msg.value");
    }

    function _nativeRebalanceValue(
        uint256 collateralAmount
    ) internal override returns (uint256 nativeValue) {
        nativeValue = msg.value + collateralAmount;
        require(
            address(this).balance >= nativeValue,
            "Native: rebalance amount exceeds balance"
        );
    }

    /**
     * @dev Sends `_amount` of native token to `_recipient` balance.
     * @inheritdoc TokenRouter
     */
    function _transferTo(
        address _recipient,
        uint256 _amount
    ) internal virtual override {
        Address.sendValue(payable(_recipient), _amount);
    }

    // TODO: only diff is msg.value for dispatch
    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) public payable virtual override returns (bytes32 messageId) {
        uint256 fee = _feeAmount(_destination, _recipient, _amount);
        _transferFromSender(_amount + fee);
        if (fee > 0) {
            _transferTo(feeRecipient(), fee);
        }

        bytes memory _tokenMessage = TokenMessage.format(
            _recipient,
            _outboundAmount(_amount)
        );

        // effects
        emit SentTransferRemote(_destination, _recipient, _amount);

        // interactions
        // TODO: Consider flattening with GasRouter
        messageId = _GasRouter_dispatch(
            _destination,
            msg.value - (_amount + fee),
            _tokenMessage,
            address(hook)
        );
    }

    receive() external payable {
        donate(msg.value);
    }
}
