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
import "forge-std/console.sol";

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

    /// @notice The WETH contract interface
    IWETH public immutable weth;
    /// @notice The Everclear spoke contract
    address public immutable everclearSpoke;

    /**
     * @notice Constructor to initialize the Everclear ETH bridge
     * @param _weth The address of the WETH contract
     * @param _everclearAdapter The address of the Everclear adapter contract
     * @param _everclearSpoke The address of the Everclear spoke contract
     */
    constructor(
        IWETH _weth,
        uint256 _scale,
        address _mailbox,
        IEverclearAdapter _everclearAdapter,
        address _everclearSpoke
    )
        EverclearTokenBridge(
            address(_weth),
            _scale,
            _mailbox,
            _everclearAdapter
        )
    {
        weth = _weth;
        everclearSpoke = _everclearSpoke;
    }

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
        console.log("msg.value");
        console.logUint(msg.value);
        console.log("_amount");
        console.logUint(_amount);
        require(msg.value >= _amount, "EEB: ETH amount mismatch");
        weth.deposit{value: _amount}();
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

    /**
     * @notice Gets the calldata for the intent that will unwrap WETH to ETH on destination
     * @dev Overrides parent to return calldata for unwrapping WETH to ETH
     * @return The encoded calldata for the unwrap and send operation
     */
    function _getIntentCalldata(
        bytes32 _recipient,
        uint256 _amount
    ) internal view override returns (bytes memory) {
        // This encodes a call to the _unwrapAndSend function
        bytes memory _calldata = abi.encodeCall(
            this.unwrapAndSend,
            (_recipient, _amount)
        );
        bytes memory intentCalldata = abi.encode(address(this), _calldata);
        return intentCalldata;
    }

    /**
     * @notice Internal function to unwrap WETH to ETH and send to recipient
     * @dev This function will be called on the destination chain via the EverclearSpoke.executeIntentCalldata() function
     * @param _recipient The address to receive the unwrapped ETH
     * @param _amount The amount of WETH to unwrap and send
     */
    function unwrapAndSend(bytes32 _recipient, uint256 _amount) external {
        require(
            msg.sender == everclearSpoke,
            "EEB: Only callable by EverclearSpoke"
        );
        // Withdraw WETH to ETH
        weth.withdraw(_amount);

        // Send ETH to recipient
        payable(_recipient.bytes32ToAddress()).sendValue(_amount);
    }

    function _handle(
        uint32 _origin,
        bytes32 /* sender */,
        bytes calldata _message
    ) internal override {
        // Get intent from hyperlane message
        bytes memory metadata = _message.metadata();
        IEverclear.Intent memory intent = abi.decode(
            metadata,
            (IEverclear.Intent)
        );

        // Validate the intent.
        super._handle(_origin, bytes32(0), _message);

        // Execute intentcalldata
        everclearAdapter.spoke().executeIntentCalldata(intent);
    }

    function _transferTo(
        address _recipient,
        uint256 _amount
    ) internal virtual override {
        // No-op. ETH will be sent in spoke.executeIntentCalldata()
    }

    /**
     * @notice Receive function to accept ETH
     */
    receive() external payable {}
}
