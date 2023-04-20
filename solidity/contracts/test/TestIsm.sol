// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";

contract TestIsm is IInterchainSecurityModule {
    uint8 public constant moduleType = 0;
    bool public accept;

    constructor() {
        accept = true;
    }

    function setAccept(bool _val) external {
        accept = _val;
    }

    function verify(bytes calldata, bytes calldata)
        external
        view
        returns (bool)
    {
        return accept;
    }
}
