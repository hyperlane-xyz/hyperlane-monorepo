// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

struct Quote {
    address token;
    uint256 amount;
}

abstract contract ValueTransferBridge {
    function quoteTransferRemote(
        uint32 destinationDomain,
        bytes32 recipient,
        uint amountOut
    ) public view virtual returns (Quote[] memory) {}

    function transferRemote(
        uint32 destinationDomain,
        bytes32 recipient,
        uint256 amountOut
    ) external payable virtual returns (bytes32 transferId) {}
}
