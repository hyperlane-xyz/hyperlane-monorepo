// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import "../Router.sol";

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

contract TestUpgradeableRouter is Router, Initializable {
    function initialize(address _abacusConnectionManager) external initializer {
        _setAbacusConnectionManager(_abacusConnectionManager);
    }
}
