// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ValueTransferBridge, Quote} from "../token/libs/ValueTransferBridge.sol";

contract MockValueTransferBridge is ValueTransferBridge {
    function quoteTransferRemote(
        uint32, //_destinationDomain,
        bytes32, //_recipient,
        uint256 //_amountOut
    ) public view virtual override returns (Quote[] memory) {
        return new Quote[](0);
    }

    function transferRemote(
        uint32, //_destinationDomain,
        bytes32, //_recipient,
        uint256 //_amountOut
    ) external payable virtual override returns (bytes32 transferId) {
        return keccak256("transferId");
    }
}
