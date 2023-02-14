// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {InterchainGasPaymaster} from "../igps/InterchainGasPaymaster.sol";

contract TestInterchainGasPaymaster is InterchainGasPaymaster {
    uint256 gasPrice = 0;

    function setGasPrice(uint256 _gasPrice) external {
        gasPrice = _gasPrice;
    }

    function quoteGasPayment(uint32, uint256 gasAmount)
        public
        view
        override
        returns (uint256)
    {
        return gasPrice * gasAmount;
    }
}
