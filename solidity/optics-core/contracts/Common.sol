// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

// ============ Internal Imports ============
import {Message} from "../libs/Message.sol";
// ============ External Imports ============
import {ECDSA} from "@openzeppelin/contracts/cryptography/ECDSA.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/Initializable.sol";

/**
 * @title Common
 * @author Celo Labs Inc.
 * @notice Shared utilities between Home and Replica.
 */
abstract contract Common is Initializable {
    // ============ Enums ============

    // States:
    //   0 - UnInitialized - before initialize function is called
    //   note: the contract is initialized at deploy time, so it should never be in this state
    //   1 - Active - as long as the contract has not become fraudulent
    //   2 - Failed - after a valid fraud proof has been submitted;
    //   contract will no longer accept updates or new messages
    enum States {
        UnInitialized,
        Active,
        Failed
    }

    // ============ Immutable Variables ============

    // Domain of chain on which the contract is deployed
    uint32 public immutable localDomain;

    // ============ Public Variables ============

    // Address of bonded Updater
    address public updater;
    // Current state of contract
    States public state;

    // ============ Upgrade Gap ============

    // gap for upgrade safety
    uint256[47] private __GAP;

    // ============ Events ============

    /**
     * @notice Emitted when Updater is rotated
     * @param updater The address of the new updater
     */
    event NewUpdater(address updater);

    // ============ Modifiers ============

    /**
     * @notice Ensures that contract state != FAILED when the function is called
     */
    modifier notFailed() {
        require(state != States.Failed, "failed state");
        _;
    }

    // ============ Constructor ============

    constructor(uint32 _localDomain) {
        localDomain = _localDomain;
    }

    // ============ Initializer ============

    function __Common_initialize(address _updater) internal initializer {
        updater = _updater;
        state = States.Active;
    }

    // ============ Public Functions ============

    /**
     * @notice Hash of Home domain concatenated with "OPTICS"
     */
    function homeDomainHash() public view virtual returns (bytes32);

    // ============ Internal Functions ============

    /**
     * @notice Hash of Home domain concatenated with "OPTICS"
     * @param _homeDomain the Home domain to hash
     */
    function _homeDomainHash(uint32 _homeDomain)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(_homeDomain, "OPTICS"));
    }

    /**
     * @notice Set contract state to FAILED
     * @dev Called when a valid fraud proof is submitted
     */
    function _setFailed() internal {
        state = States.Failed;
    }

    /**
     * @notice Moves the contract into failed state
     * @dev Called when fraud is proven
     * (Double Update is submitted on Home or Replica,
     * or Improper Update is submitted on Home)
     */
    function _fail() internal virtual;

    /**
     * @notice Checks that signature was signed by Updater
     * @param _root Merkle root
     * @param _index Corresponding leaf index
     * @param _signature Signature on `_root` and `_index`
     * @return TRUE iff signature is valid signed by updater
     **/
    function _isUpdaterSignature(
        bytes32 _root,
        uint256 _index,
        bytes memory _signature
    ) internal view returns (bool) {
        bytes32 _digest = keccak256(
            abi.encodePacked(homeDomainHash(), _root, _index)
        );
        _digest = ECDSA.toEthSignedMessageHash(_digest);
        return (ECDSA.recover(_digest, _signature) == updater);
    }

    /**
     * @notice Set the Updater
     * @param _updater Address of the Updater
     */
    function _setUpdater(address _updater) internal {
        updater = _updater;
        emit NewUpdater(_updater);
    }
}
