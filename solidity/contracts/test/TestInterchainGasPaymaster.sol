// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IInterchainGasPaymaster} from "../../interfaces/IInterchainGasPaymaster.sol";

contract TestInterchainGasPaymaster is IInterchainGasPaymaster {
    function initialize() external {}

    function payForGas(
        bytes32 _messageId,
        uint32,
        uint256 _gasAmount,
        address
    ) external payable override {
        emit GasPayment(_messageId, _gasAmount, msg.value);
    }

    function quoteGasPayment(uint32, uint256)
        public
        pure
        override
        returns (uint256)
    {
        return 0;
    }
}
