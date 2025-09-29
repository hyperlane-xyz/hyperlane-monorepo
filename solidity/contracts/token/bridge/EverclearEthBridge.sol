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
     * @param _weth The WETH contract address for wrapping/unwrapping ETH
     * @param _scale The scaling factor for token amounts (typically 1 for 18-decimal tokens)
     * @param _mailbox The address of the Hyperlane mailbox contract
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

    /**
     * @notice Gets the receiver address for an ETH transfer intent
     * @dev Overrides parent to use the remote router instead of direct recipient
     * @param _destination The destination domain ID
     * @return receiver The remote router address that will handle the ETH transfer
     */
    function _getReceiver(
        uint32 _destination,
        bytes32 /* _recipient */
    ) internal view override returns (bytes32 receiver) {
        return _mustHaveRemoteRouter(_destination);
    }

    /**
     * @notice Encodes the intent calldata for ETH transfers
     * @dev Overrides parent to encode recipient and amount for ETH-specific intent validation
     * @param _recipient The recipient address on the destination chain
     * @param _amount The amount of ETH to transfer
     * @return The encoded calldata containing recipient and amount
     */
    function _getIntentCalldata(
        bytes32 _recipient,
        uint256 _amount
    ) internal pure override returns (bytes memory) {
        return abi.encode(_recipient, _amount);
    }

    /**
     * @notice Provides a quote for transferring ETH to a remote chain
     * @dev Overrides parent to return a single quote for ETH (including transfer amount, fees, and gas)
     * @param _destination The destination domain ID
     * @param _recipient The recipient address on the destination chain
     * @param _amount The amount of ETH to transfer
     * @return quotes Array containing a single quote with total ETH amount needed
     */
    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) public view override returns (Quote[] memory quotes) {
        quotes = new Quote[](1);
        quotes[0] = Quote({
            token: address(0),
            amount: _amount +
                feeParams[_destination].fee +
                _quoteGasPayment(_destination, _recipient, _amount)
        });
    }

    /**
     * @notice Transfers ETH from sender, wrapping to WETH
     * @dev Requires msg.value to be at least the specified amount, then wraps ETH to WETH
     * @param _amount The amount of ETH to wrap to WETH (includes transfer amount and fees)
     */
    function _transferFromSender(uint256 _amount) internal override {
        // The `_amount` here will be amount + fee where amount is what the user wants to send,
        // And `fee` is what is being payed to everclear.
        // The user will also include the gas payment in the msg.value.
        require(msg.value >= _amount, "EEB: ETH amount mismatch");
        IWETH(address(wrappedToken)).deposit{value: _amount}();
    }

    /**
     * @notice Transfers ETH to a recipient by unwrapping WETH and sending native ETH
     * @dev Unwraps WETH to ETH and uses Address.sendValue for safe ETH transfer
     * @param _recipient The address to receive the ETH
     * @param _amount The amount of ETH to transfer
     */
    function _transferTo(
        address _recipient,
        uint256 _amount
    ) internal override {
        // Withdraw WETH to ETH
        IWETH(address(wrappedToken)).withdraw(_amount);

        // Send ETH to recipient
        payable(_recipient).sendValue(_amount);
    }

    /**
     * @notice Charges the sender for ETH transfer including all fees
     * @dev Overrides parent to handle ETH-specific charging logic with fee calculation and distribution
     * @param _destination The destination domain ID
     * @param _recipient The recipient address on the destination chain
     * @param _amount The amount of ETH to transfer (excluding fees)
     * @return dispatchValue The remaining ETH value to include with the Hyperlane message dispatch
     */
    function _chargeSender(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) internal virtual override returns (uint256 dispatchValue) {
        uint256 fee = _feeAmount(_destination, _recipient, _amount);

        uint256 totalAmount = _amount + fee + feeParams[_destination].fee;
        _transferFromSender(totalAmount);
        dispatchValue = msg.value - totalAmount;
        if (fee > 0) {
            _transferTo(feeRecipient(), fee);
        }
        return dispatchValue;
    }

    /**
     * @notice Allows the contract to receive ETH
     * @dev Required for WETH unwrapping functionality
     */
    receive() external payable {
        require(
            msg.sender == address(wrappedToken),
            "EEB: Only WETH can send ETH"
        );
    }
}
