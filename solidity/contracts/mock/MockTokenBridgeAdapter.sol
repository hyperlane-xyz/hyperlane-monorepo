// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {ITokenBridgeAdapter} from "../middleware/token-bridge/interfaces/ITokenBridgeAdapter.sol";

contract MockTokenBridgeAdapter is ITokenBridgeAdapter {
    uint256 nonce = 0;

    function bridgeToken(
        uint32 _destinationDomain,
        bytes32 _recipientAddress,
        address _token,
        uint256 _amount
    ) external override returns (bytes memory _adapterData) {
        _destinationDomain;
        _recipientAddress;
        _token;
        _amount;

        nonce = nonce + 1;
        return abi.encode(nonce);
    }

    function sendBridgedTokens(
        uint32 _originDomain, // Hyperlane domain
        address _recipientAddress,
        bytes calldata _adapterData, // The adapter data from the message
        uint256 _amount
    ) external pure override returns (address, uint256) {
        _originDomain;
        _recipientAddress;
        _adapterData;
        _amount;

        return (address(0), 0);
    }
}
