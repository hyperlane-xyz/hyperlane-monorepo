// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
pragma abicoder v2;

// ============ Internal Imports ============
import {IInbox} from "../../interfaces/IInbox.sol";
import {MultisigValidatorManager} from "./MultisigValidatorManager.sol";
import {BN256} from "../../libs/BN256.sol";
import "hardhat/console.sol";

/**
 * @title InboxValidatorManager
 * @notice Verifies checkpoints are signed by a quorum of validators and submits
 * them to an Inbox.
 */
contract InboxValidatorManager is MultisigValidatorManager {
    using BN256 for BN256.G1Point;
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

    BN256.G1Point public aggregateKey;
    // Maps the hash of -1 * publicKey to whether or not the public key is in the validator set.
    mapping(bytes32 => bool) public inverseKeys;
    function setAggregateKey(BN256.G1Point calldata key) public {
        aggregateKey = key;
    }

    function sprocess(
        IInbox _inbox,
        bytes32 _root,
        uint256 _index,
        BN256.G1Point calldata nonce,
        uint256 randomness,
        uint256 signature,
        BN256.G1Point[] calldata _missing,
        bytes calldata _message,
        bytes32[32] calldata _proof,
        uint256 _leafIndex
    ) external {
        bytes32 digest = keccak256(
            abi.encodePacked(domainHash, _root, _index)
        );
        require(verify(nonce, randomness, signature, _missing, digest), "!sig");
        // emit Quorum(_root, _index, _signatures);
        // emit Quorum2(_root, _index, _root, missing);
        // emit Quorum3(_root, _index, _sigData, _missing);
        _inbox.process(_root, _index, _message, _proof, _leafIndex, "0x00");
    }

    function verify(
        BN256.G1Point calldata nonce,
        uint256 randomness,
        uint256 signature,
        BN256.G1Point[] calldata missing,
        bytes32 digest
    ) public view returns (bool) {
        BN256.G1Point memory publicKey = aggregateKey;
        // TODO: Do we need to check for repeats in here? Probably.
        /*
        for (uint256 i = 0; i < missing.length; i++) {
            BN256.G1Point memory missingPoint = missing[i];
            bytes32 missingId = keccak256(abi.encodePacked(missingPoint.x, missingPoint.y));
            require(inverseKeys[missingId], "!inverse");
            publicKey = publicKey.add(missingPoint[i]);
        }
        */
        uint256 challenge = uint256(keccak256(abi.encodePacked(randomness, digest)));
        BN256.G1Point memory verification = nonce.add(publicKey.mul(challenge));
        return BN256.g().mul(signature).eq(verification);
    }

    function ecGen(uint256 s) public view returns (BN256.G1Point memory) {
        return BN256.g().mul(s);
    }

    function scalarMod(uint256 a) public pure returns (uint256) {
        return BN256.mod(a);
    }

    function sign(uint256 a, uint256 b, uint256 c) public pure returns (uint256) {
        return BN256.add(a, BN256.mul(b, c));
    }
}
