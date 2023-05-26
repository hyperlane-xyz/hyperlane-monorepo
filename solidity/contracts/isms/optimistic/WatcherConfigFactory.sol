// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

// ============ Internal Imports ============
import {MetaProxy} from "./MetaProxy.sol";

abstract contract WatcherConfigFactory is StaticMOfNAddressSetFactory {

address private immutable _implementation;

constructor() {
    _implementation = _deployImplementation();
}

    function _deployImplementation()
        internal
        virtual
        override
        returns (address)
    {
        return address(new OptimisticISM());
    }

}






}