// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

interface ILiquidityLayerAdapterV2 {
    // do we need address _token here?
    function transferRemote(
        uint32 _destinationDomain,
        bytes32 _recipientAddress,
        uint256 _amount
    ) external returns (bytes32);
}
