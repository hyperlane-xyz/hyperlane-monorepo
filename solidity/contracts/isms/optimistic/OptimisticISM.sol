// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ External Imports ============
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

// ============ Internal Imports ============
import {MessageIdMultisigIsmMetadata} from "../../libs/isms/MessageIdMultisigIsmMetadata.sol";
import {Message} from "../../libs/Message.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {IOptimisticIsm} from "../../interfaces/isms/IOptimisticIsm.sol";

/**
 * @title OptimisticIsm
 * @notice Manages submodule that is used to pre-verify
 * interchain messages.
 */
abstract contract OptimisticIsm is IOptimisticIsm, AccessControl {
    // ============ Constants ============

    // solhint-disable-next-line const-name-snakecase
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.OPTIMISTIC);

    // Could have used OZ Owner's library, but since we already use AccessControl
    // We can just use that one here too
    bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");
    bytes32 public constant WATCHER_ROLE = keccak256("WATCHER_ROLE");

    // ============ Immutable state ============

    address private immutable owner;

    // The number of watchers needed to mark a submodule as compromised
    uint256 private immutable compromisedWatcherCount;

    // The fraud window before a message can be delivered
    uint256 private immutable fraudWindow;

    // ============ Private state ============

    address private submoduleAddress;
    address[] private watchers;

    // Mapping for which watcher marked a submodule as compomised
    mapping(address => mapping(address => bool)) private watcherSubmoduleFlag;
    // How many times a submodule was flagged
    mapping(address => uint256) private submoduleFlagCount;
    // The time the message was pre-verified
    mapping(bytes32 => uint256) private preverifiedTimestamps;
    // Mapping of messages that are marked as fraudulent
    mapping(bytes32 => bool) private fraudulentMessages;

    // ============ Modifier Functions ============

    modifier onlyOwner() {
        require(hasRole(OWNER_ROLE, msg.sender), "Caller is not owner");
        _;
    }

    modifier onlyWatchers() {
        require(hasRole(WATCHER_ROLE, msg.sender), "Caller is not a watcher");
        _;
    }

    // ============ Public Functions ============

    constructor(uint256 _compromisedWatcherCount) {
        owner = msg.sender;
        compromisedWatcherCount = _compromisedWatcherCount;
        _grantRole(OWNER_ROLE, msg.sender);
    }

    function setWatchers(address[] calldata _watchers) external onlyOwner {
        for (uint256 i = 0; i < watchers.length; ) {
            _revokeRole(WATCHER_ROLE, watchers[i]);
            unchecked {
                ++i;
            }
        }

        watchers = _watchers;

        for (uint256 i = 0; i < _watchers.length; ) {
            _grantRole(WATCHER_ROLE, _watchers[i]);
            unchecked {
                ++i;
            }
        }
    }

    function preVerify(bytes calldata _metadata, bytes calldata _message)
        external
        onlyWatchers
        returns (bool)
    {
        require(
            IInterchainSecurityModule(submoduleAddress).verify(message),
            "Message was not verified"
        );

        preverifiedTimestamps[Message.id(_message)] = block.timestamp;

        return true;
    }

    function markFraudulent(bytes32 _id) external onlyWatchers {
        delete preverifiedTimestamps[_id];
        fraudulentMessages[_id] = true;
    }

    function markCompromised(address _submodule) external onlyWatchers {
        require(
            watcherSubmoduleFlag[submodule][msg.sender] == false,
            "Watcher already flagged that submodule"
        );
        watcherSubmoduleFlag[submodule][msg.sender] = true;
        submoduleFlagCount[submodule] += 1;
    }

    function submodule(bytes calldata _message)
        external
        view
        returns (IInterchainSecurityModule)
    {
        return IInterchainSecurityModule(submoduleAddress);
    }

    /**
     * @notice Requires that m-of-n validators verify a merkle root,
     * and verifies a me∑rkle proof of `_message` against that root.
     * @param _metadata ABI encoded module metadata
     * @param _message Formatted Hyperlane message (see Message.sol).
     */
    function verify(bytes calldata _metadata, bytes calldata _message)
        external
        view
        onlyWatchers
        returns (bool)
    {
        bytes32 _id = Message.id(_message);

        uint256 preverifiedTimestamp = preverifiedTimestamps[_id];

        require(
            fraudulentMessages[_id] == false,
            "Message was marked as fraudulent"
        );

        // We check threshold was elapsed
        require(
            preverifiedTimestamp > 0 &&
                blockTimestamp > preverifiedTimestamp + fraudWindow,
            "Fraud window is not elapsed"
        );

        // We check it is actually signed by the submodule
        //
        // I could have created my own Metadata library
        // to reduce filesize and only include 1 signer
        bytes32 _digest = CheckpointLib.digest(
            Message.origin(_message),
            MessageIdMultisigIsmMetadata.originMailbox(_metadata),
            MessageIdMultisigIsmMetadata.root(_metadata),
            Message.nonce(_message),
            _id
        );

        address _preverifier = ECDSA.recover(
            _digest,
            MessageIdMultisigIsmMetadata.signatureAt(_metadata, 0)
        );

        // Fail if they don't match
        require(
            _preverifier == submoduleAddress,
            "_preverifier doesn't match submodule"
        );

        require(
            submoduleFlagCount[_preverifier] < compromisedWatcherCount,
            "Submodule was flagged as compromised"
        );

        return true;
    }
}
