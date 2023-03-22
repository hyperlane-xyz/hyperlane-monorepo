// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

// ============ Internal Imports ============
import {AbstractRoutingIsm} from "./AbstractRoutingIsm.sol";
import {IInterchainSecurityModule} from "../../../interfaces/IInterchainSecurityModule.sol";
import {Message} from "../../libs/Message.sol";

/**
 * @title DomainRoutingIsm
 */
contract DomainRoutingIsm is AbstractRoutingIsm, Ownable {
    // ============ Public Storage ============
    mapping(uint32 => IInterchainSecurityModule) public modules;

    // ============ Events ============

    /**
     * @notice Emitted when a module is set for a domain
     * @param domain The origin domain.
     * @param module The ISM to use.
     */
    event ModuleSet(uint32 indexed domain, IInterchainSecurityModule module);

    // ============ Constructor ============

    // solhint-disable-next-line no-empty-blocks
    constructor() Ownable() {}

    // ============ External Functions ============
    function set(uint32 _domain, IInterchainSecurityModule _module)
        external
        onlyOwner
    {
        modules[_domain] = _module;
        emit ModuleSet(_domain, _module);
    }

    // ============ Public Functions ============

    function route(bytes calldata _message)
        public
        view
        virtual
        override
        returns (IInterchainSecurityModule)
    {
        return modules[Message.origin(_message)];
    }
}
