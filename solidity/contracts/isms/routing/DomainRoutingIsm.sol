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

    /**
     * @notice Sets the ISMs to be used for the specified origin domains
     * @param _domains The origin domains
     * @param _modules The ISMs to use to verify messages
     */
    function set(
        uint32[] calldata _domains,
        IInterchainSecurityModule[] calldata _modules
    ) external onlyOwner {
        require(_domains.length == _modules.length, "length mismatch");
        uint256 _length = _domains.length;
        for (uint256 i = 0; i < _length; ++i) {
            _set(_domains[i], _modules[i]);
        }
    }

    /**
     * @notice Sets the ISM to be used for the specified origin domain
     * @param _domain The origin domain
     * @param _module The ISM to use to verify messages
     */
    function set(uint32 _domain, IInterchainSecurityModule _module)
        external
        onlyOwner
    {
        _set(_domain, _module);
    }

    // ============ Public Functions ============

    /**
     * @notice Returns the ISM to use to verify `_message`
     * @param _message The Hyperlane formatted message, see Message.sol
     * @return The ISM to use to verify `_message`
     */
    function route(bytes calldata _message)
        public
        view
        virtual
        override
        returns (IInterchainSecurityModule)
    {
        IInterchainSecurityModule module = modules[Message.origin(_message)];
        require(
            address(module) != address(0),
            "No ISM found for origin domain"
        );
        return module;
    }

    // ============ Internal Functions ============

    /**
     * @notice Sets the ISM to be used for the specified origin domain
     * @param _domain The origin domain
     * @param _module The ISM to use to verify messages
     */
    function _set(uint32 _domain, IInterchainSecurityModule _module) internal {
        modules[_domain] = _module;
        emit ModuleSet(_domain, _module);
    }
}
