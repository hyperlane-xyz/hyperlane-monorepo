// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {ITokenMessenger} from "../middleware/liquidity-layer/interfaces/circle/ITokenMessenger.sol";
import {MockToken} from "./MockToken.sol";

contract MockCircleTokenMessenger is ITokenMessenger {
    uint64 public nextNonce = 0;
    MockToken token;

    constructor(MockToken _token) {
        token = _token;
    }

    function depositForBurn(
        uint256 _amount,
        uint32,
        bytes32,
        address _burnToken
    ) external returns (uint64 _nonce) {
        nextNonce = nextNonce + 1;
        _nonce = nextNonce;
        require(address(token) == _burnToken);
        token.transferFrom(msg.sender, address(this), _amount);
        token.burn(_amount);
    }

    function depositForBurnWithCaller(
        uint256,
        uint32,
        bytes32,
        address,
        bytes32
    ) external returns (uint64 _nonce) {
        nextNonce = nextNonce + 1;
        _nonce = nextNonce;
    }
}
