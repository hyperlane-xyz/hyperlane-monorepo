// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

interface ILiquidityLayerAdapterV2 {
    function transferRemote(
        uint32 _destinationDomain,
        bytes32 _recipientAddress,
        uint256 _amount
    ) external returns (bytes32);

    function payForGas(
        bytes32 _messageId,
        uint32 _destinationDomain,
        uint256 _gasAmount,
        address _refundAddress
    ) external payable;

    function quoteGasPayment(uint32 _destinationDomain)
        external
        view
        returns (uint256);
}
