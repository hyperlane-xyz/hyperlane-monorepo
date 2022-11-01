// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {ITokenBridgeAdapter} from "../middleware/token-bridge/interfaces/ITokenBridgeAdapter.sol";
import {MockToken} from "./MockToken.sol";

contract MockTokenBridgeAdapter is ITokenBridgeAdapter {
    uint256 public nonce = 0;
    MockToken token;

    mapping(uint256 => bool) public isProcessed;

    constructor(MockToken _token) {
        token = _token;
    }

    function sendTokens(
        uint32,
        bytes32,
        address _token,
        uint256 _amount
    ) external override returns (bytes memory _adapterData) {
        require(_token == address(token), "cant bridge this token");
        token.burn(_amount);
        nonce = nonce + 1;
        return abi.encode(nonce);
    }

    function process(uint256 _nonce) public {
        isProcessed[_nonce] = true;
    }

    function receiveTokens(
        uint32 _originDomain, // Hyperlane domain
        address _recipientAddress,
        uint256 _amount,
        bytes calldata _adapterData // The adapter data from the message
    ) external override returns (address, uint256) {
        _originDomain;
        uint256 _nonce = abi.decode(_adapterData, (uint256));
        // Check if the transfer was processed first
        require(isProcessed[_nonce], "Transfer has not been processed yet");
        token.mint(_recipientAddress, _amount);
        return (address(0), 0);
    }
}
