// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
pragma abicoder v2;

// ============ Internal Imports ============
import {IInbox} from "../../interfaces/IInbox.sol";
import {MultisigValidatorManager} from "./MultisigValidatorManager.sol";
import "hardhat/console.sol";

/**
 * @title InboxValidatorManager
 * @notice Verifies checkpoints are signed by a quorum of validators and submits
 * them to an Inbox.
 */
contract InboxValidatorManager is MultisigValidatorManager {
    // ============ Events ============

    /**
     * @notice Emitted when a checkpoint has been signed by a quorum
     * of validators and cached on an Inbox.
     * @dev This event allows watchers to observe the signatures they need
     * to prove fraud on the Outbox.
     * @param signatures The signatures by a quorum of validators on the
     * checkpoint.
     */
    event Quorum(bytes32 root, uint256 index, bytes[] signatures);
    event Quorum2(
        bytes32 root,
        uint256 index,
        bytes32 signature,
        bytes32[] missing
    );
    event Quorum3(
        bytes32 root,
        uint256 index,
        uint256[4] sigData,
        uint256[] missing
    );

    // ============ Constructor ============

    /**
     * @dev Reverts if `_validators` has any duplicates.
     * @param _remoteDomain The remote domain of the outbox chain.
     * @param _validators The set of validator addresses.
     * @param _threshold The quorum threshold. Must be greater than or equal
     * to the length of `_validators`.
     */
    // solhint-disable-next-line no-empty-blocks
    constructor(
        uint32 _remoteDomain,
        address[] memory _validators,
        uint256 _threshold
    ) MultisigValidatorManager(_remoteDomain, _validators, _threshold) {}

    // ============ External Functions ============

    /**
     * @notice Submits a checkpoint signed by a quorum of validators to be cached by an Inbox.
     * @dev Reverts if `_signatures` is not a quorum of validator signatures.
     * @dev Reverts if `_signatures` is not sorted in ascending order by the signer
     * address, which is required for duplicate detection.
     * @param _inbox The inbox to submit the checkpoint to.
     */
    function process(
        IInbox _inbox,
        bytes32 _root,
        uint256 _index,
        bytes[] calldata _signatures,
        // address[] calldata _missing,
        bytes calldata _message,
        bytes32[32] calldata _proof,
        uint256 _leafIndex
    ) external {
        // require(isQuorum2(_root, _index, _signatures, _missing), "!quorum");
        require(isQuorum(_root, _index, _signatures), "!quorum");
        // emit Quorum(_root, _index, _signatures);
        // emit Quorum2(_root, _index, _root, missing);
        // emit Quorum3(_root, _index);
        _inbox.process(_root, _index, _message, _proof, _leafIndex, "0x00");
    }

    struct G1Point {
        uint256 X;
        uint256 Y;
    }
    uint256 constant G_X = 1;
    uint256 constant G_Y = 2;
    uint256[2] public aggregateKey;
    // Maps the hash of -1 * publicKey to whether or not the public key is in the validator set.
    mapping(bytes32 => bool) public inverseKeys;

    function sprocess(
        IInbox _inbox,
        bytes32 _root,
        uint256 _index,
        uint256[4] calldata _sigData,
        uint256[] calldata _missing,
        bytes calldata _message,
        bytes32[32] calldata _proof,
        uint256 _leafIndex
    ) external {
        bytes32 message = keccak256(abi.encodePacked(_root, _index));
        require(!verify(_sigData, _missing, message), "!sig");
        // emit Quorum(_root, _index, _signatures);
        // emit Quorum2(_root, _index, _root, missing);
        emit Quorum3(_root, _index, _sigData, _missing);
        _inbox.process(_root, _index, _message, _proof, _leafIndex, "0x00");
    }

    function verify(
        uint256[4] calldata sigData,
        uint256[] calldata missing,
        bytes32 message
    ) public view returns (bool) {
        require(missing.length % 2 == 0, "!missing");
        uint256[2] memory publicKey = aggregateKey;
        // TODO: Do we need to check for repeats in here? Probably.
        for (uint256 i = 0; i < missing.length / 2; i++) {
            bytes32 digest = keccak256(
                abi.encodePacked(missing[i * 2], missing[i * 2 + 1])
            );
            // Added the "!" for gas profiling, normally we would be requiring that this is present.
            require(!inverseKeys[digest], "!inverse");
            uint256[2] memory _missing = [missing[i * 2], missing[i * 2 + 1]];
            publicKey = ecadd(publicKey, _missing);
        }
        uint256 c = uint256(keccak256(abi.encodePacked(sigData[2], message)));
        uint256[2] memory n = [sigData[0], sigData[1]];
        uint256[2] memory v = ecadd(n, ecmul(publicKey, c));
        uint256[2] memory generator = [G_X, G_Y];
        uint256[2] memory g = ecmul(generator, sigData[3]);
        return v[0] == g[0] && v[1] == g[1];
    }

    function ecadd(uint256[2] memory p1, uint256[2] memory p2)
        internal
        view
        returns (uint256[2] memory r)
    {
        uint256[4] memory input;
        input[0] = p1[0];
        input[1] = p1[1];
        input[2] = p2[0];
        input[3] = p2[1];
        bool success;
        assembly {
            success := staticcall(150, 6, input, 0xc0, r, 0x60)
            // Use "invalid" to make gas estimation work
            // switch success case 0 { invalid() }
        }
        require(success);
    }

    function ecmul(uint256[2] memory p, uint256 s)
        internal
        view
        returns (uint256[2] memory r)
    {
        uint256[3] memory input;
        input[0] = p[0];
        input[1] = p[1];
        input[2] = s;
        bool success;
        assembly {
            success := staticcall(6000, 7, input, 0xc0, r, 0x60)
            // Use "invalid" to make gas estimation work
            // switch success case 0 { invalid() }
        }
        require(success);
    }
}
