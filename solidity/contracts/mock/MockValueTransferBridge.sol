// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {ValueTransferBridge, Quote} from "../token/libs/ValueTransferBridge.sol";

contract MockValueTransferBridge is ValueTransferBridge {
    event SentTransferRemote(
        uint32 indexed origin,
        uint32 indexed destination,
        bytes32 indexed recipient,
        uint256 amount
    );

    function quoteTransferRemote(
        uint32, //_destinationDomain,
        bytes32, //_recipient,
        uint256 //_amountOut
    ) public view virtual override returns (Quote[] memory) {
        Quote[] memory quotes = new Quote[](1);
        quotes[0] = Quote(address(0), 1);

        return quotes;
    }

    function transferRemote(
        uint32 _destinationDomain,
        bytes32 _recipient,
        uint256 _amountOut
    ) external payable virtual override returns (bytes32 transferId) {
        emit SentTransferRemote(
            uint32(block.chainid),
            _destinationDomain,
            _recipient,
            _amountOut
        );

        return keccak256("transferId");
    }
}
