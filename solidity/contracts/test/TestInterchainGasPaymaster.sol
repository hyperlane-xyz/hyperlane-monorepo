// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {InterchainGasPaymaster} from "../igps/InterchainGasPaymaster.sol";

contract TestInterchainGasPaymaster is InterchainGasPaymaster {
    uint256 public constant gasPrice = 10;

    // Ensure the same constructor interface as the inherited InterchainGasPaymaster
    constructor(address _beneficiary) {
        initialize(msg.sender, _beneficiary);
    }

    function quoteGasPayment(uint32, uint256 gasAmount)
        public
        pure
        override
        returns (uint256)
    {
        return gasPrice * gasAmount;
    }
}
