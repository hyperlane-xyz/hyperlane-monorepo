// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import {EverclearTokenBridge} from "./EverclearTokenBridge.sol";
import {IEverclearAdapter} from "../../interfaces/IEverclearAdapter.sol";
import {IWETH} from "../interfaces/IWETH.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";

/**
 * @title EverclearEthBridge
 * @author Hyperlane Team
 * @notice A specialized ETH bridge that integrates with Everclear's intent-based architecture
 * @dev Extends EverclearTokenBridge to handle ETH by wrapping to WETH for transfers and unwrapping on destination
 */
contract EverclearEthBridge is EverclearTokenBridge {
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
        IEverclearAdapter _everclearAdapter,
        address _everclearSpoke
    ) EverclearTokenBridge(IERC20(address(_weth)), _everclearAdapter) {
        weth = _weth;
        everclearSpoke = _everclearSpoke;
    }

    /**
     * @notice Transfers tokens from sender, wrapping ETH to WETH if necessary
     * @dev Overrides parent to handle ETH wrapping via WETH.deposit
     * @param _from The address to transfer from
     * @param _to The address to transfer to
     * @param _amount The amount to transfer
     */
    function _transferFrom(
        address _from,
        address _to,
        uint256 _amount
    ) internal override {
        // For user transfers, deposit ETH to WETH first
        require(msg.value == _amount, "EEB: ETH amount mismatch");
        weth.deposit{value: _amount}();
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

    /**
     * @notice Receive function to accept ETH
     */
    receive() external payable {}
}
