// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {Proxy} from "@openzeppelin/contracts/proxy/Proxy.sol";

contract TestProxy is Proxy {
    address immutable implementation;

    constructor(address __implementation) {
        implementation = __implementation;
    }

    function _implementation() internal view override returns (address) {
        return implementation;
    }
}
