// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

// ============ Internal Imports ============
import {IUpdaterManager} from "../interfaces/IUpdaterManager.sol";
import {Home} from "./Home.sol";
// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/cryptography/ECDSA.sol";

/**
 * @title UpdaterManager
 * @author Celo Labs Inc.
 * @notice MVP version of contract that will manage Updater selection and
 * rotataion.
 */
contract UpdaterManager is IUpdaterManager, Ownable {
    // Mapping of domain -> updater address.
    mapping(uint32 => address) public updaters;

    // ============ Events ============

    /**
     * @notice Emitted when an updater is set
     * @param domain The domain for which the updater is being set
     * @param updater The address of the updater
     */
    event NewUpdater(uint32 indexed domain, address indexed updater);

    /**
     * @notice Emitted when proof of an improper update is submitted,
     * which sets the contract to FAILED state
     * @param root Root of the improper update
     * @param index Index of the improper update
     * @param signature Signature on `root` and `index`
     */
    event ImproperUpdate(
        address indexed home,
        uint32 indexed domain,
        address indexed updater,
        bytes32 root,
        uint256 index,
        bytes signature
    );

    // ============ Constructor ============

    constructor() Ownable() {}

    // ============ External Functions ============

    /**
     * @notice Set the address of a new updater
     * @dev only callable by trusted owner
     * @param _domain The domain for which the updater is being set
     * @param _updater The address of the updater
     */
    function setUpdater(uint32 _domain, address _updater) external onlyOwner {
        updaters[_domain] = _updater;
        emit NewUpdater(_domain, _updater);
    }

    /**
     * @notice Check if an Update is an Improper Update;
     * if so, set the provided Home contract to FAILED state.
     *
     * An Improper Update is an update that was not previously checkpointed.
     * @param _home Address of the Home contract to set to FAILED.
     * @param _root Merkle root of the improper update
     * @param _index Index root of the improper update
     * @param _signature Updater signature on `_root` and `_index`
     * @return TRUE if update was an Improper Update (implying Updater was slashed)
     */
    function improperUpdate(
        address _home,
        bytes32 _root,
        uint256 _index,
        bytes memory _signature
    ) external returns (bool) {
        uint32 _domain = Home(_home).localDomain();
        require(
            isUpdaterSignature(_domain, _root, _index, _signature),
            "!updater sig"
        );
        require(Home(_home).checkpoints(_root) != _index, "!improper");
        Home(_home).fail();
        emit ImproperUpdate(
            _home,
            _domain,
            updaters[_domain],
            _root,
            _index,
            _signature
        );
        return true;
    }

    // ============ Public Functions ============

    /**
     * @notice Checks that signature was signed by Updater
     * @param _domain Domain of Home contract
     * @param _root Merkle root
     * @param _index Corresponding leaf index
     * @param _signature Signature on `_root` and `_index`
     * @return TRUE iff signature is valid signed by updater
     **/
    function isUpdaterSignature(
        uint32 _domain,
        bytes32 _root,
        uint256 _index,
        bytes memory _signature
    ) public view override returns (bool) {
        bytes32 _digest = keccak256(
            abi.encodePacked(domainHash(_domain), _root, _index)
        );
        _digest = ECDSA.toEthSignedMessageHash(_digest);
        return (ECDSA.recover(_digest, _signature) == updaters[_domain]);
    }

    /**
     * @notice Hash of domain concatenated with "ABACUS"
     * @param _domain the domain to hash
     */
    function domainHash(uint32 _domain) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(_domain, "ABACUS"));
    }
}
