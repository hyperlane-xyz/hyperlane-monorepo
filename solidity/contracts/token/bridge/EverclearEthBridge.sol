// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import {EverclearTokenBridge, Quote} from "./EverclearTokenBridge.sol";
import {IEverclearAdapter, IEverclear} from "../../interfaces/IEverclearAdapter.sol";
import {IWETH} from "../interfaces/IWETH.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {TokenMessage} from "../libs/TokenMessage.sol";
import {EverclearBridge} from "../libs/EverclearBridge.sol";
import {WETHCollateral} from "../libs/TokenCollateral.sol";
import {TokenRouter} from "../libs/TokenRouter.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title EverclearEthBridge
 * @author Hyperlane Team
 * @notice A specialized ETH bridge that integrates with Everclear's intent-based architecture
 * @dev Extends EverclearTokenBridge to handle ETH by wrapping to WETH for transfers and unwrapping on destination
 */
contract EverclearEthBridge is EverclearBridge {
    using WETHCollateral for IWETH;
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
    ) EverclearBridge(_everclearAdapter, IERC20(_weth), _scale, _mailbox) {}

    // senders and recipients are ETH, so we return address(0)
    function token() public pure override returns (address) {
        return address(0);
    }

    /**
     * @notice Transfers ETH from sender, wrapping to WETH
     */
    function _transferFromSender(uint256 _amount) internal override {
        IWETH(address(wrappedToken))._transferFromSender(_amount);
    }

    function _transferTo(
        address _recipient,
        uint256 _amount
    ) internal override {
        IWETH(address(wrappedToken))._transferTo(_recipient, _amount);
    }
}
