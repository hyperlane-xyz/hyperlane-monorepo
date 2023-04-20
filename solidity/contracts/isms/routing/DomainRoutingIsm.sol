// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

// ============ Internal Imports ============
import {AbstractRoutingIsm} from "./AbstractRoutingIsm.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {Message} from "../../libs/Message.sol";

/**
 * @title DomainRoutingIsm
 */
contract DomainRoutingIsm is AbstractRoutingIsm, OwnableUpgradeable {
    // ============ Public Storage ============
    mapping(uint32 => IInterchainSecurityModule) public modules;

    // ============ Events ============

    /**
     * @notice Emitted when a module is set for a domain
     * @param domain The origin domain.
     * @param module The ISM to use.
     */
    event ModuleSet(uint32 indexed domain, IInterchainSecurityModule module);

    // ============ External Functions ============

    /**
     * @param _owner The owner of the contract.
     */
    function initialize(address _owner) public initializer {
        __Ownable_init();
        _transferOwnership(_owner);
    }

    /**
     * @notice Sets the ISMs to be used for the specified origin domains
     * @param _owner The owner of the contract.
     * @param _domains The origin domains
     * @param _modules The ISMs to use to verify messages
     */
    function initialize(
        address _owner,
        uint32[] calldata _domains,
        IInterchainSecurityModule[] calldata _modules
    ) public initializer {
        __Ownable_init();
        require(_domains.length == _modules.length, "length mismatch");
        uint256 _length = _domains.length;
        for (uint256 i = 0; i < _length; ++i) {
            _set(_domains[i], _modules[i]);
        }
        _transferOwnership(_owner);
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
     * @notice Returns the ISM responsible for verifying _message
     * @dev Can change based on the content of _message
     * @param _message Formatted Hyperlane message (see Message.sol).
     * @return module The ISM to use to verify _message
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
        require(Address.isContract(address(_module)), "!contract");
        modules[_domain] = _module;
        emit ModuleSet(_domain, _module);
    }
}
