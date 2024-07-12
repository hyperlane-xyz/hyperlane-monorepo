// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IRemoteChallenger} from "../interfaces/avs/IRemoteChallenger.sol";
import {HyperlaneServiceManager} from "../avs/HyperlaneServiceManager.sol";

contract TestRemoteChallenger is IRemoteChallenger {
    HyperlaneServiceManager internal immutable hsm;

    constructor(HyperlaneServiceManager _hsm) {
        hsm = _hsm;
    }

    function challengeDelayBlocks() external pure returns (uint256) {
        return 50400; // one week of eth L1 blocks
    }

    function handleChallenge(address operator) external {
        hsm.freezeOperator(operator);
    }
}
