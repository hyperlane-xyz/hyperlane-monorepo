// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IRemoteChallenger} from "../interfaces/avs/IRemoteChallenger.sol";

contract TestRemoteChallenger is IRemoteChallenger {
    function challengeDelayBlocks() external view returns (uint256) {
        return 50400; // one week of eth L1 blocks
    }

    function handleChallenge(address operator) external {}
}
