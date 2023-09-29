// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

// ============ Internal Imports ============
import {AbstractRoutingIsm} from "./AbstractRoutingIsm.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {Message} from "../../libs/Message.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {EnumerableMapExtended} from "../../libs/EnumerableMapExtended.sol";

/**
 * @title DomainRoutingIsm
 */
contract DomainRoutingIsm is AbstractRoutingIsm, OwnableUpgradeable {
    using EnumerableMapExtended for EnumerableMapExtended.UintToBytes32Map;
    using Message for bytes;
    using TypeCasts for bytes32;
    using TypeCasts for address;
    using Address for address;
    using Strings for uint32;

    // ============ Mutable Storage ============
    EnumerableMapExtended.UintToBytes32Map internal _modules;

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
     * @param __modules The ISMs to use to verify messages
     */
    function initialize(
        address _owner,
        uint32[] calldata _domains,
        IInterchainSecurityModule[] calldata __modules
    ) public initializer {
        __Ownable_init();
        require(_domains.length == __modules.length, "length mismatch");
        uint256 _length = _domains.length;
        for (uint256 i = 0; i < _length; ++i) {
            _set(_domains[i], address(__modules[i]));
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
        _set(_domain, address(_module));
    }

    /**
     * @notice Removes the specified origin domain
     * @param _domain The origin domain
     */
    function remove(uint32 _domain) external onlyOwner {
        _remove(_domain);
    }

    function domains() external view returns (uint256[] memory) {
        return _modules.keys();
    }

    function module(uint32 origin)
        public
        view
        virtual
        returns (IInterchainSecurityModule)
    {
        (bool contained, bytes32 _module) = _modules.tryGet(origin);
        require(contained, _originNotFoundError(origin));
        return IInterchainSecurityModule(_module.bytes32ToAddress());
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
        override
        returns (IInterchainSecurityModule)
    {
        return module(_message.origin());
    }

    // ============ Internal Functions ============

    /**
     * @notice Removes the specified origin domain's ISM
     * @param _domain The origin domain
     */
    function _remove(uint32 _domain) internal {
        require(_modules.remove(_domain), _originNotFoundError(_domain));
    }

    function _originNotFoundError(uint32 _origin)
        internal
        pure
        returns (string memory)
    {
        return string.concat("No ISM found for origin: ", _origin.toString());
    }

    /**
     * @notice Sets the ISM to be used for the specified origin domain
     * @param _domain The origin domain
     * @param _module The ISM to use to verify messages
     */
    function _set(uint32 _domain, address _module) internal {
        require(_module.isContract(), "ISM must be a contract");
        _modules.set(_domain, _module.addressToBytes32());
    }
}
