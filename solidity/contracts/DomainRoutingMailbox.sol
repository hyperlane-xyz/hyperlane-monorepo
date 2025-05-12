// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IMailbox} from "./interfaces/IMailbox.sol";
import {IInterchainSecurityModule} from "./interfaces/IInterchainSecurityModule.sol";
import {IPostDispatchHook} from "./interfaces/hooks/IPostDispatchHook.sol";
import {Message} from "./libs/Message.sol";
import {TypeCasts} from "./libs/TypeCasts.sol";

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @title DomainRoutingMailbox
 * @notice A mailbox router that forwards calls to different underlying mailboxes
 * based on the destination domain (for dispatch) or origin domain (for process).
 * If no specific mailbox is configured for a domain, it falls back to a default mailbox.
 * This contract implements the IMailbox interface, allowing it to be used
 * wherever an IMailbox is expected, acting as a configurable proxy.
 *
 * @dev This contract itself does not hold message state (like `delivered` status
 * or `nonce`). It relies entirely on the underlying mailboxes it routes to.
 * Functions like `localDomain`, `delivered`, `defaultIsm`, `defaultHook`,
 * `requiredHook`, and `latestDispatchedId` primarily reflect the state of the
 * *default* mailbox, as the router itself doesn't have a single canonical state
 * for these values across all routed domains.
 */
contract DomainRoutingMailbox is Initializable, OwnableUpgradeable, IMailbox {
    using Message for bytes;
    using Address for address;
    using TypeCasts for bytes32;
    using TypeCasts for address;

    // ============ State Variables ============

    // The default mailbox used when no domain-specific mailbox is configured.
    IMailbox public defaultMailbox;

    // Mapping from domain ID to its specific mailbox implementation.
    mapping(uint32 => IMailbox) internal domainMailboxes;

    // ============ Events ============

    event DefaultMailboxSet(address indexed mailbox);
    event DomainMailboxSet(uint32 indexed domain, address indexed mailbox);
    event DomainMailboxRemoved(uint32 indexed domain);

    // ============ Initializer ============

    /**
     * @notice Initializes the DomainRoutingMailbox.
     * @param _owner The initial owner of the contract.
     * @param _defaultMailbox The address of the default mailbox implementation.
     */
    function initialize(
        address _owner,
        address _defaultMailbox
    ) external initializer {
        __Ownable_init();
        setDefaultMailbox(_defaultMailbox);
        transferOwnership(_owner);
    }

    // ============ Configuration Functions (Owner-only) ============

    /**
     * @notice Sets the default mailbox.
     * @param _mailbox Address of the new default mailbox. Must be a contract
     * implementing IMailbox.
     */
    function setDefaultMailbox(address _mailbox) public onlyOwner {
        require(_mailbox != address(0), "DRM: Zero address");
        require(_mailbox.isContract(), "DRM: Default mailbox not contract");
        // Minimal check: ensure it implements localDomain() to reduce chances of incorrect interface
        try IMailbox(_mailbox).localDomain() {} catch {
            revert("DRM: Default mailbox invalid interface");
        }
        defaultMailbox = IMailbox(_mailbox);
        emit DefaultMailboxSet(_mailbox);
    }

    /**
     * @notice Sets a specific mailbox for a given domain.
     * @param _domain The domain ID to configure.
     * @param _mailbox Address of the mailbox for the specified domain. Must be a contract
     * implementing IMailbox. Use address(0) to remove mapping (will fallback to default).
     */
    function setDomainMailbox(
        uint32 _domain,
        address _mailbox
    ) public onlyOwner {
        if (_mailbox == address(0)) {
            delete domainMailboxes[_domain];
            emit DomainMailboxRemoved(_domain);
        } else {
            require(_mailbox.isContract(), "DRM: Domain mailbox not contract");
            // Minimal check: ensure it implements localDomain() to reduce chances of incorrect interface
            try IMailbox(_mailbox).localDomain() {} catch {
                revert("DRM: Domain mailbox invalid interface");
            }
            domainMailboxes[_domain] = IMailbox(_mailbox);
            emit DomainMailboxSet(_domain, _mailbox);
        }
    }

    // ============ Routing Logic ============

    /**
     * @notice Returns the mailbox responsible for handling a given domain.
     * @dev Falls back to the default mailbox if no specific one is set for the domain.
     * @param _domain The domain ID.
     * @return The IMailbox instance for the domain.
     */
    function getMailboxForDomain(
        uint32 _domain
    ) public view returns (IMailbox) {
        IMailbox mailbox = domainMailboxes[_domain];
        if (address(mailbox) != address(0)) {
            return mailbox;
        } else {
            require(
                address(defaultMailbox) != address(0),
                "DRM: Default mailbox not set"
            );
            return defaultMailbox;
        }
    }

    // ============ IMailbox Implementation (Routing) ============

    /**
     * @notice Returns the local domain.
     * @dev Returns the local domain of the *default* mailbox.
     */
    function localDomain() external view override returns (uint32) {
        require(
            address(defaultMailbox) != address(0),
            "DRM: Default mailbox not set"
        );
        return defaultMailbox.localDomain();
    }

    /**
     * @notice Checks if a message has been delivered.
     * @dev Routes the check to the mailbox associated with the message's *origin* domain.
     * @param _messageId The ID of the message to check.
     * @return bool True if the message has been delivered according to the responsible mailbox.
     * @dev **Limitation**: This function *cannot* determine the origin domain from the message ID alone.
     *      It currently forwards the check to the *default* mailbox. A more robust implementation
     *      might require additional context or storage, which deviates from a simple router.
     */
    function delivered(
        bytes32 _messageId
    ) external view override returns (bool) {
        // WARNING: Cannot determine origin domain from messageId. Forwarding to default.
        // Consider implications if messages can be processed by non-default mailboxes.
        require(
            address(defaultMailbox) != address(0),
            "DRM: Default mailbox not set"
        );
        return defaultMailbox.delivered(_messageId);
    }

    /**
     * @notice Checks if a message has been delivered by querying the mailbox for its origin domain.
     * @dev Unlike the standard delivered() function, this allows specifying the origin domain
     *      to properly route the check to the correct mailbox. This is more accurate than the
     *      default delivered() implementation when messages may be processed by non-default mailboxes.
     * @param _messageId The ID of the message to check.
     * @param _originDomain The domain where the message originated from.
     * @return bool True if the message has been delivered according to the origin domain's mailbox.
     */
    function deliveredForOrigin(
        bytes32 _messageId,
        uint32 _originDomain
    ) external view returns (bool) {
        IMailbox targetMailbox = getMailboxForDomain(_originDomain);
        return targetMailbox.delivered(_messageId);
    }

    /**
     * @notice Gets the default ISM.
     * @dev Returns the default ISM of the *default* mailbox.
     */
    function defaultIsm()
        external
        view
        override
        returns (IInterchainSecurityModule)
    {
        require(
            address(defaultMailbox) != address(0),
            "DRM: Default mailbox not set"
        );
        return defaultMailbox.defaultIsm();
    }

    /**
     * @notice Gets the default hook.
     * @dev Returns the default hook of the *default* mailbox.
     */
    function defaultHook() external view override returns (IPostDispatchHook) {
        require(
            address(defaultMailbox) != address(0),
            "DRM: Default mailbox not set"
        );
        return defaultMailbox.defaultHook();
    }

    /**
     * @notice Gets the required hook.
     * @dev Returns the required hook of the *default* mailbox.
     */
    function requiredHook() external view override returns (IPostDispatchHook) {
        require(
            address(defaultMailbox) != address(0),
            "DRM: Default mailbox not set"
        );
        return defaultMailbox.requiredHook();
    }

    /**
     * @notice Gets the latest dispatched message ID.
     * @dev Returns the latest dispatched ID from the *default* mailbox.
     * This might not be globally accurate if multiple mailboxes are actively used.
     */
    function latestDispatchedId() external view override returns (bytes32) {
        // WARNING: This reflects the default mailbox's state, not a global state.
        require(
            address(defaultMailbox) != address(0),
            "DRM: Default mailbox not set"
        );
        return defaultMailbox.latestDispatchedId();
    }

    /**
     * @notice Dispatches a message, routing to the mailbox based on destination domain.
     */
    function dispatch(
        uint32 destinationDomain,
        bytes32 recipientAddress,
        bytes calldata messageBody
    ) external payable override returns (bytes32 messageId) {
        IMailbox targetMailbox = getMailboxForDomain(destinationDomain);
        messageId = targetMailbox.dispatch{value: msg.value}(
            destinationDomain,
            recipientAddress,
            messageBody
        );
        // Note: Events are emitted by the targetMailbox, not this router.
    }

    /**
     * @notice Computes the fee for dispatch, routing to the mailbox based on destination domain.
     */
    function quoteDispatch(
        uint32 destinationDomain,
        bytes32 recipientAddress,
        bytes calldata messageBody
    ) external view override returns (uint256 fee) {
        IMailbox targetMailbox = getMailboxForDomain(destinationDomain);
        return
            targetMailbox.quoteDispatch(
                destinationDomain,
                recipientAddress,
                messageBody
            );
    }

    /**
     * @notice Dispatches a message with default hook metadata, routing based on destination domain.
     */
    function dispatch(
        uint32 destinationDomain,
        bytes32 recipientAddress,
        bytes calldata body,
        bytes calldata defaultHookMetadata
    ) external payable override returns (bytes32 messageId) {
        IMailbox targetMailbox = getMailboxForDomain(destinationDomain);
        messageId = targetMailbox.dispatch{value: msg.value}(
            destinationDomain,
            recipientAddress,
            body,
            defaultHookMetadata
        );
        // Note: Events are emitted by the targetMailbox, not this router.
    }

    /**
     * @notice Computes the fee for dispatch with default hook metadata, routing based on destination domain.
     */
    function quoteDispatch(
        uint32 destinationDomain,
        bytes32 recipientAddress,
        bytes calldata messageBody,
        bytes calldata defaultHookMetadata
    ) external view override returns (uint256 fee) {
        IMailbox targetMailbox = getMailboxForDomain(destinationDomain);
        return
            targetMailbox.quoteDispatch(
                destinationDomain,
                recipientAddress,
                messageBody,
                defaultHookMetadata
            );
    }

    /**
     * @notice Dispatches a message with custom hook metadata, routing based on destination domain.
     */
    function dispatch(
        uint32 destinationDomain,
        bytes32 recipientAddress,
        bytes calldata body,
        bytes calldata customHookMetadata,
        IPostDispatchHook customHook
    ) external payable override returns (bytes32 messageId) {
        IMailbox targetMailbox = getMailboxForDomain(destinationDomain);
        messageId = targetMailbox.dispatch{value: msg.value}(
            destinationDomain,
            recipientAddress,
            body,
            customHookMetadata,
            customHook // Pass the custom hook through
        );
        // Note: Events are emitted by the targetMailbox, not this router.
    }

    /**
     * @notice Computes the fee for dispatch with custom hook metadata, routing based on destination domain.
     */
    function quoteDispatch(
        uint32 destinationDomain,
        bytes32 recipientAddress,
        bytes calldata messageBody,
        bytes calldata customHookMetadata,
        IPostDispatchHook customHook
    ) external view override returns (uint256 fee) {
        IMailbox targetMailbox = getMailboxForDomain(destinationDomain);
        return
            targetMailbox.quoteDispatch(
                destinationDomain,
                recipientAddress,
                messageBody,
                customHookMetadata,
                customHook // Pass the custom hook through
            );
    }

    /**
     * @notice Processes a message, routing to the mailbox based on the message's *origin* domain.
     * @param _metadata The ISM metadata.
     * @param _message The Hyperlane message payload.
     */
    function process(
        bytes calldata _metadata,
        bytes calldata _message
    ) external payable override {
        // Determine the origin domain from the message itself
        uint32 originDomain = _message.origin();

        // Route based on origin domain for processing incoming messages
        IMailbox targetMailbox = getMailboxForDomain(originDomain);

        targetMailbox.process{value: msg.value}(_metadata, _message);
        // Note: Events are emitted by the targetMailbox, not this router.
    }

    /**
     * @notice Gets the ISM for a recipient.
     * @dev Routes the query to the mailbox responsible for the *current chain*.
     *      Assumes the router is deployed on a chain represented by the *default* mailbox's domain.
     */
    function recipientIsm(
        address recipient
    ) external view override returns (IInterchainSecurityModule module) {
        // This check happens locally, so route to the mailbox representing this chain (the default).
        require(
            address(defaultMailbox) != address(0),
            "DRM: Default mailbox not set"
        );
        return defaultMailbox.recipientIsm(recipient);
    }

    // --- Helper functions not part of IMailbox but useful for introspection ---

    /**
     * @notice Returns the specific mailbox configured for a domain, if any.
     * @param _domain The domain ID.
     * @return The address of the configured mailbox, or address(0) if none is set (uses default).
     */
    function getSpecificDomainMailbox(
        uint32 _domain
    ) external view returns (address) {
        return address(domainMailboxes[_domain]);
    }
}
