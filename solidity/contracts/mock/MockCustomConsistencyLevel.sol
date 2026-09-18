// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.19;

import {ICustomConsistencyLevel} from "wormhole-sdk/interfaces/ICustomConsistencyLevel.sol";

contract MockCustomConsistencyLevel is ICustomConsistencyLevel {
    mapping(address emitter => bytes32 config) public configurations;

    function configure(bytes32 config) external {
        configurations[msg.sender] = config;
        emit ConfigSet(msg.sender, config);
    }

    function getConfiguration(
        address emitterAddress
    ) external view returns (bytes32) {
        return configurations[emitterAddress];
    }
}
