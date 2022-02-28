// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import "../Common.sol";

contract TestCommon is Common {
    constructor(uint32 _localDomain) Common(_localDomain) {}

    function initialize(address _updaterManager) external {
        __Common_initialize(_updaterManager);
    }
}
