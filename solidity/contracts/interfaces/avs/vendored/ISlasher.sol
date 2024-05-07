// SPDX-License-Identifier: BUSL-1.1
pragma solidity >=0.5.0;

interface ISlasher {
    function freezeOperator(address toBeFrozen) external;
}
