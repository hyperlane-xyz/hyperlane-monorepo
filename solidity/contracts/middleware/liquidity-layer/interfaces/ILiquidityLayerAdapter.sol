// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

interface ILiquidityLayerAdapter {
    function sendTokens(
        uint32 _destinationDomain,
        bytes32 _recipientAddress,
        address _token,
        uint256 _amount
    ) external returns (bytes memory _adapterData);

    function receiveTokens(
        uint32 _originDomain, // Hyperlane domain
        address _recipientAddress,
        uint256 _amount,
        bytes calldata _adapterData // The adapter data from the message
    ) external returns (address, uint256);
}
