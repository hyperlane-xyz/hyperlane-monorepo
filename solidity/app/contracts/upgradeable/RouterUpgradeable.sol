// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {Router} from "../Router.sol";

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

abstract contract RouterUpgradeable is Router, Initializable {
    // See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
    uint256[50] private __GAP;

    constructor() Router(address(0)) {
        _disableInitializers();
    }

    function initialize(address _abacusConnectionManager)
        external
        virtual
        initializer
    {
        __Router__initialize(_abacusConnectionManager);
    }

    function __Router__initialize(address _abacusConnectionManager)
        internal
        onlyInitializing
    {
        _setAbacusConnectionManager(_abacusConnectionManager);
        _transferOwnership(msg.sender);
    }
}
