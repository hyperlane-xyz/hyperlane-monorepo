// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

import {IInterchainSecurityModule, ISpecifiesInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";

contract OwnableSpecifiesISM is
    ISpecifiesInterchainSecurityModule,
    OwnableUpgradeable
{
    IInterchainSecurityModule public interchainSecurityModule;

    event InterchainSecurityModuleSet(address indexed module);

    function setInterchainSecurityModule(address _module) external onlyOwner {
        _setInterchainSecurityModule(_module);
    }

    function __OwnableSpecifiesISM_init(address _module)
        internal
        onlyInitializing
    {
        __Ownable_init();
        _setInterchainSecurityModule(_module);
    }

    function _setInterchainSecurityModule(address _module) internal {
        require(Address.isContract(_module), "!contract");
        interchainSecurityModule = IInterchainSecurityModule(_module);
        emit InterchainSecurityModuleSet(_module);
    }
}
