// SPDX-License-Identifier: BUSL-1.1
pragma solidity >=0.5.0;

import {IStrategy} from "./IStrategy.sol";

struct StrategyParams {
    IStrategy strategy; // The strategy contract reference
    uint96 multiplier; // The multiplier applied to the strategy
}

struct Quorum {
    StrategyParams[] strategies; // An array of strategy parameters to define the quorum
}

interface IECDSAStakeRegistry {
    function quorum() external view returns (Quorum memory);
}
