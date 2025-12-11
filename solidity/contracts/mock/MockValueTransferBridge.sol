// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {ITokenBridge, Quote} from "../interfaces/ITokenBridge.sol";

contract MockValueTransferBridge is ITokenBridge {
    address public collateral;

    constructor(address _collateral) {
        collateral = _collateral;
    }

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
        quotes[0] = Quote(collateral, 1);

        return quotes;
    }

    function transferRemote(
        uint32 _destinationDomain,
        bytes32 _recipient,
        uint256 _amountOut
    ) external payable virtual override returns (bytes32 transferId) {
        emit SentTransferRemote({
            origin: uint32(block.chainid),
            destination: _destinationDomain,
            recipient: _recipient,
            amount: _amountOut
        });

        return keccak256("transferId");
    }
}
