// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {TokenRouter} from "./libs/TokenRouter.sol";
import {FungibleTokenRouter} from "./libs/FungibleTokenRouter.sol";
import {MovableCollateralRouter} from "./libs/MovableCollateralRouter.sol";
import {Quote, ITokenBridge} from "../interfaces/ITokenBridge.sol";

import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title Hyperlane Native Token Router that extends ERC20 with remote transfer functionality.
 * @author Abacus Works
 * @dev Supply on each chain is not constant but the aggregate supply across all chains is.
 */
contract HypNative is MovableCollateralRouter {
    string internal constant INSUFFICIENT_NATIVE_AMOUNT =
        "Native: amount exceeds msg.value";

    /**
     * @dev Emitted when native tokens are donated to the contract.
     * @param sender The address of the sender.
     * @param amount The amount of native tokens donated.
     */
    event Donation(address indexed sender, uint256 amount);

    constructor(
        uint256 _scale,
        address _mailbox
    ) FungibleTokenRouter(_scale, _mailbox) {}

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

    function balanceOf(
        address _account
    ) external view override returns (uint256) {
        return _account.balance;
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

    function _transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        uint256 _value,
        bytes memory _hookMetadata,
        address _hook
    ) internal virtual override returns (bytes32 messageId) {
        // include for legible error instead of underflow
        _transferFromSender(_amount);

        return
            super._transferRemote(
                _destination,
                _recipient,
                _amount,
                msg.value - _amount,
                _hookMetadata,
                _hook
            );
    }

    /**
     * @inheritdoc TokenRouter
     */
    function _transferFromSender(
        uint256 _amount
    ) internal virtual override returns (bytes memory) {
        require(msg.value >= _amount, "Native: amount exceeds msg.value");
        return bytes(""); // no metadata
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
        uint256 _amount,
        bytes calldata // no metadata
    ) internal virtual override {
        Address.sendValue(payable(_recipient), _amount);
    }

    receive() external payable {
        emit Donation(msg.sender, msg.value);
    }
}
