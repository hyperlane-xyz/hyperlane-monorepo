// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {TokenRouter} from "../libs/TokenRouter.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";

/**
 * @title HypPrivate
 * @notice Base contract for privacy-enhanced cross-chain token transfers via Aleo
 * @dev Single contract per chain - can both send to and receive from Aleo privacy hub
 * @author Hyperlane
 */
abstract contract HypPrivate is TokenRouter {
    using TypeCasts for bytes32;
    using TypeCasts for address;

    // ============ Immutables ============

    /// @notice Address of the Aleo privacy hub program
    bytes32 public immutable aleoPrivacyHub;

    /// @notice Hyperlane domain ID for Aleo
    uint32 public immutable aleoDomain;

    // ============ Public Storage ============

    /// @notice Monotonically increasing nonce for commitment uniqueness
    uint256 public commitmentNonce;

    /// @notice Tracks used commitments to prevent replay attacks
    mapping(bytes32 => bool) public usedCommitments;

    /// @notice Maps destination domain to remote HypPrivate router address
    mapping(uint32 => bytes32) public remoteRouters;

    // ============ Events ============

    /**
     * @notice Emitted when tokens are deposited for private transfer via Aleo
     * @param depositor Address that deposited the tokens
     * @param commitment Keccak256 commitment hash
     * @param finalDestination Domain ID of ultimate destination chain
     * @param destinationRouter Address of destination HypPrivate contract
     * @param amount Amount of tokens deposited
     */
    event DepositToPrivacyHub(
        address indexed depositor,
        bytes32 indexed commitment,
        uint32 finalDestination,
        bytes32 destinationRouter,
        uint256 amount
    );

    /**
     * @notice Emitted when tokens are received from Aleo privacy hub
     * @param commitment Commitment hash from original deposit
     * @param recipient Address receiving the tokens
     * @param amount Amount of tokens received
     */
    event ReceivedFromPrivacyHub(
        bytes32 indexed commitment,
        address indexed recipient,
        uint256 amount
    );

    /**
     * @notice Emitted when a remote router is enrolled for a destination
     * @param domain Destination domain ID
     * @param router Address of HypPrivate contract on destination
     */
    event RemoteRouterEnrolled(uint32 indexed domain, bytes32 router);

    // ============ Constructor ============

    constructor(
        uint256 _scale,
        address _mailbox,
        bytes32 _aleoPrivacyHub,
        uint32 _aleoDomain
    ) TokenRouter(_scale, _mailbox) {
        aleoPrivacyHub = _aleoPrivacyHub;
        aleoDomain = _aleoDomain;
        commitmentNonce = 0;
    }

    /**
     * @notice Internal initialization to enroll Aleo in parent router
     * @dev Must be called by child contract initializers
     */
    function _HypPrivate_initialize() internal {
        // Enroll Aleo privacy hub in parent Router for gas calculations
        _enrollRemoteRouter(aleoDomain, aleoPrivacyHub);
    }

    // ============ Public View Functions ============

    /**
     * @notice Get gas payment for destination
     * @param _destination Destination domain
     * @return Gas payment amount
     */
    function _gasPayment(uint32 _destination) internal view returns (uint256) {
        return quoteGasPayment(_destination);
    }

    // ============ External Functions ============

    /**
     * @notice Enroll a remote router for a destination domain
     * @dev Must be called before deposits can be made to that destination
     * @param domain Destination domain ID
     * @param router Address of HypPrivate contract on destination (as bytes32)
     */
    function enrollRemoteRouter(
        uint32 domain,
        bytes32 router
    ) public virtual override onlyOwner {
        require(domain != aleoDomain, "HypPrivate: cannot enroll Aleo");
        require(router != bytes32(0), "HypPrivate: zero router");

        // Store in local mapping
        remoteRouters[domain] = router;

        // Also enroll in parent Router for gas calculations
        _enrollRemoteRouter(domain, router);

        emit RemoteRouterEnrolled(domain, router);
    }

    /**
     * @notice Compute commitment hash for private transfer
     * @dev Uses Keccak256 to match Aleo's Keccak256::hash_to_field
     * @param secret User-generated 32-byte secret
     * @param recipient Final recipient address (bytes32)
     * @param amount Transfer amount (uint256)
     * @param destinationDomain Destination chain domain ID
     * @param destinationRouter Destination HypPrivate contract address
     * @param nonce Current commitment nonce
     * @return Commitment hash
     */
    function computeCommitment(
        bytes32 secret,
        bytes32 recipient,
        uint256 amount,
        uint32 destinationDomain,
        bytes32 destinationRouter,
        uint256 nonce
    ) public pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    secret,
                    recipient,
                    amount,
                    destinationDomain,
                    destinationRouter,
                    nonce
                )
            );
    }

    /**
     * @notice Deposit tokens for private transfer via Aleo
     * @dev Tokens are locked on origin, message sent to Aleo privacy hub
     * @param secret User-generated 32-byte secret (must be kept secure)
     * @param finalDestination Destination chain domain ID
     * @param recipient Final recipient address (bytes32)
     * @param amount Amount of tokens to deposit
     * @return messageId Hyperlane message ID
     * @return commitment Generated commitment hash
     */
    function depositPrivate(
        bytes32 secret,
        uint32 finalDestination,
        bytes32 recipient,
        uint256 amount
    ) public payable virtual returns (bytes32 messageId, bytes32 commitment) {
        require(
            finalDestination != aleoDomain,
            "HypPrivate: cannot deposit to Aleo"
        );

        // Get enrolled destination router
        bytes32 destinationRouter = remoteRouters[finalDestination];
        require(
            destinationRouter != bytes32(0),
            "HypPrivate: router not enrolled"
        );

        // Validate amount
        require(amount > 0, "HypPrivate: zero amount");
        require(amount <= type(uint128).max, "HypPrivate: amount exceeds u128");

        _transferFromSender(amount);

        // Generate commitment with current nonce
        uint256 nonce = commitmentNonce++;

        commitment = computeCommitment(
            secret,
            recipient,
            amount,
            finalDestination,
            destinationRouter,
            nonce
        );

        // Encode message: [commitment][amount][nonce][finalDest][recipient][destRouter]
        // Using encodePacked for fixed layout (Aleo compatibility)
        bytes memory messageBody = abi.encodePacked(
            commitment, // 32 bytes
            amount, // 32 bytes (uint256)
            uint32(nonce), // 4 bytes
            finalDestination, // 4 bytes
            recipient, // 32 bytes
            destinationRouter // 32 bytes
        );
        // Total: 136 bytes

        // Pad to 141 bytes (supported Aleo message length)
        messageBody = abi.encodePacked(messageBody, new bytes(5));

        assert(messageBody.length == 141);

        // Dispatch to Aleo privacy hub directly (not through router)
        messageId = mailbox.dispatch{value: _gasPayment(aleoDomain)}(
            aleoDomain,
            aleoPrivacyHub,
            messageBody
        );

        emit DepositToPrivacyHub(
            msg.sender,
            commitment,
            finalDestination,
            destinationRouter,
            amount
        );
    }

    /**
     * @notice Handle incoming transfer from Aleo privacy hub
     * @dev Called by Mailbox.process() - only accepts messages from Aleo hub
     * @param _origin Origin domain (must be Aleo)
     * @param _sender Sender address (must be Aleo privacy hub)
     * @param _message Message: [recipient][amount][commitment] (109 bytes)
     */
    function _handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _message
    ) internal virtual override {
        require(_origin == aleoDomain, "HypPrivate: origin not Aleo");
        require(_sender == aleoPrivacyHub, "HypPrivate: sender not hub");
        require(_message.length == 109, "HypPrivate: invalid message length");

        // Decode message using assembly for exact byte offsets
        // Layout: [recipient(32)][amount(32)][commitment(32)][padding(13)]
        bytes32 recipientBytes;
        uint256 amount;
        bytes32 commitment;

        assembly {
            recipientBytes := calldataload(add(_message.offset, 0)) // 0-31
            amount := calldataload(add(_message.offset, 32)) // 32-63
            commitment := calldataload(add(_message.offset, 64)) // 64-95
            // Padding bytes 96-108 ignored
        }

        address recipient = recipientBytes.bytes32ToAddress();

        // Prevent commitment replay
        require(
            !usedCommitments[commitment],
            "HypPrivate: commitment already used"
        );
        usedCommitments[commitment] = true;

        // Transfer to recipient
        _transferTo(recipient, amount);

        emit ReceivedFromPrivacyHub(commitment, recipient, amount);
    }

    // ============ Query Functions ============

    /**
     * @notice Check if a commitment has been used
     * @param commitment Commitment hash to check
     * @return True if commitment has been used
     */
    function isCommitmentUsed(bytes32 commitment) external view returns (bool) {
        return usedCommitments[commitment];
    }

    /**
     * @notice Get the enrolled router for a destination domain
     * @param domain Destination domain ID
     * @return Router address (bytes32)
     */
    function getRemoteRouter(uint32 domain) external view returns (bytes32) {
        return remoteRouters[domain];
    }

    // ============ Internal Functions ============

    /**
     * @dev Returns msg.value for payable functions, 0 otherwise
     */
    function _msgValue() internal view virtual returns (uint256) {
        return msg.value;
    }

    // ============ Internal Functions ============

    /**
     * @inheritdoc TokenRouter
     */
    function _transferFromSender(uint256 _amountOrId) internal virtual override;

    /**
     * @inheritdoc TokenRouter
     */
    function _transferTo(
        address _recipient,
        uint256 _amountOrId
    ) internal virtual override;
}
