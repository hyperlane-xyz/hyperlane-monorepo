// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IInterchainGasPaymaster} from "../../interfaces/IInterchainGasPaymaster.sol";

contract MockInterchainGasPaymaster is IInterchainGasPaymaster {
    function payForGas(
        bytes32 _messageId,
        uint32,
        uint256 _gasAmount,
        address
    ) external payable override {
        // Require *some* payment
        require(msg.value > 0, "insufficient interchain gas payment");

        emit GasPayment(_messageId, _gasAmount, msg.value);
    }

    function quoteGasPayment(uint32, uint256)
        external
        pure
        override
        returns (uint256)
    {
        return 1;
    }
}
