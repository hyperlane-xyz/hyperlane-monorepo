// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IMailbox} from "../interfaces/IMailbox.sol";
import {IValidatorManager} from "../interfaces/IValidatorManager.sol";
import {BN256} from "../libs/BN256.sol";
// ============ External Imports ============
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title Mailbox
 * @author Celo Labs Inc.
 * @notice Shared utilities between Outbox and Inbox.
 */
abstract contract Mailbox is IMailbox, OwnableUpgradeable {
    // ============ Libraries ============

    using BN256 for BN256.G1Point;

    // ============ Immutable Variables ============

    // Domain of chain on which the contract is deployed
    uint32 public immutable override localDomain;

    // ============ Public Variables ============

    // Address of the validator manager contract.
    IValidatorManager public validatorManager;

    // ============ Upgrade Gap ============

    // gap for upgrade safety
    uint256[49] private __GAP;

    // ============ Events ============

    /**
     * @notice Emitted when the validator manager contract is changed
     * @param validatorManager The address of the new validatorManager
     */
    event NewValidatorManager(address validatorManager);

    // ============ Constructor ============

    constructor(uint32 _localDomain) {
        localDomain = _localDomain;
    }

    // ============ Initializer ============

    function __Mailbox_initialize(address _validatorManager)
        internal
        onlyInitializing
    {
        // initialize owner
        __Ownable_init();
        _setValidatorManager(_validatorManager);
    }

    // ============ External Functions ============

    /**
     * @notice Set a new validator manager contract
     * @dev Mailbox(es) will initially be initialized using a trusted validator manager contract;
     * we will progressively decentralize by swapping the trusted contract with a new implementation
     * that implements Validator bonding & slashing, and rules for Validator selection & rotation
     * @param _validatorManager the new validator manager contract
     */
    function setValidatorManager(address _validatorManager) external onlyOwner {
        _setValidatorManager(_validatorManager);
    }

    // ============ Internal Functions ============

    /**
     * @notice Set the validator manager
     * @param _validatorManager Address of the validator manager
     */
    function _setValidatorManager(address _validatorManager) internal {
        require(
            Address.isContract(_validatorManager),
            "!contract validatorManager"
        );
        validatorManager = IValidatorManager(_validatorManager);
        emit NewValidatorManager(_validatorManager);
    }

    /**
     * @notice Hash of `_domain` concatenated with "ABACUS".
     * @param _domain The domain to hash.
     */
    function _domainHash(uint32 _domain) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(_domain, "ABACUS"));
    }

    function _verify(
        Signature calldata _sig,
        Checkpoint calldata _checkpoint,
        uint32 _domain
    ) public view returns (bool) {
        BN256.G1Point memory _key = validatorManager.verificationKey(
            _domain,
            _sig.missing
        );
        uint256 _challenge = uint256(
            keccak256(
                abi.encodePacked(
                    _sig.randomness,
                    _domainHash(_domain),
                    _checkpoint.root,
                    _checkpoint.index
                )
            )
        );

        BN256.G1Point memory _verification = _sig.nonce.add(
            _key.mul(_challenge)
        );
        return BN256.g().mul(_sig.sig).eq(_verification);
    }
}
