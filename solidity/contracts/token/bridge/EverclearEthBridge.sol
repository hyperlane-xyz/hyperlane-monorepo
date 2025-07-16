// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import {EverclearTokenBridge, Quote} from "./EverclearTokenBridge.sol";
import {IEverclearAdapter, IEverclear} from "../../interfaces/IEverclearAdapter.sol";
import {IWETH} from "../interfaces/IWETH.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {HypERC20Collateral} from "../HypERC20Collateral.sol";
import {TokenMessage} from "../libs/TokenMessage.sol";

/**
 * @title EverclearEthBridge
 * @author Hyperlane Team
 * @notice A specialized ETH bridge that integrates with Everclear's intent-based architecture
 * @dev Extends EverclearTokenBridge to handle ETH by wrapping to WETH for transfers and unwrapping on destination
 */
contract EverclearEthBridge is EverclearTokenBridge {
    using TokenMessage for bytes;
    using SafeERC20 for IERC20;
    using Address for address payable;
    using TypeCasts for bytes32;

    /**
     * @notice Constructor to initialize the Everclear ETH bridge
     * @param _everclearAdapter The address of the Everclear adapter contract
     */
    constructor(
        IWETH _weth,
        uint256 _scale,
        address _mailbox,
        IEverclearAdapter _everclearAdapter
    )
        EverclearTokenBridge(
            address(_weth),
            _scale,
            _mailbox,
            _everclearAdapter
        )
    {}

    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) public view override returns (Quote[] memory quotes) {
        quotes = new Quote[](1);
        quotes[0] = Quote({
            token: address(0),
            amount: _amount +
                feeParams.fee +
                _quoteGasPayment(_destination, _recipient, _amount)
        });
    }

    /**
     * @notice Transfers ETH from sender, wrapping to WETH
     */
    function _transferFromSender(uint256 _amount) internal override {
        // The `_amount` here will be amount + fee where amount is what the user wants to send,
        // And `fee` is what is being payed to everclear.
        // The user will also include the gas payment in the msg.value.
        require(msg.value >= _amount, "EEB: ETH amount mismatch");
        IWETH(address(wrappedToken)).deposit{value: _amount}();
    }

    function _transferTo(
        address _recipient,
        uint256 _amount
    ) internal override {
        // Withdraw WETH to ETH
        IWETH(address(wrappedToken)).withdraw(_amount);

        // Send ETH to recipient
        payable(_recipient).sendValue(_amount);
    }

    function _chargeSender(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) internal virtual override returns (uint256 dispatchValue) {
        uint256 fee = _feeAmount(_destination, _recipient, _amount);

        uint256 totalAmount = _amount + fee + feeParams.fee;
        _transferFromSender(totalAmount);
        dispatchValue = msg.value - totalAmount;
        if (fee > 0) {
            _transferTo(feeRecipient(), fee);
        }
        return dispatchValue;
    }
}
