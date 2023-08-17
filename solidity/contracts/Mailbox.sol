// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {Versioned} from "./upgrade/Versioned.sol";
import {Indexed} from "./Indexed.sol";
import {Message} from "./libs/Message.sol";
import {TypeCasts} from "./libs/TypeCasts.sol";
import {IInterchainSecurityModule, ISpecifiesInterchainSecurityModule} from "./interfaces/IInterchainSecurityModule.sol";
import {IPostDispatchHook} from "./interfaces/hooks/IPostDispatchHook.sol";
import {IMessageRecipient} from "./interfaces/IMessageRecipientV3.sol";
import {IMailbox} from "./interfaces/IMailbox.sol";

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract Mailbox is IMailbox, Versioned, Ownable, Indexed {
    // ============ Libraries ============

    using Message for bytes;
    using TypeCasts for bytes32;
    using TypeCasts for address;

    // ============ Constants ============

    // Domain of chain on which the contract is deployed
    uint32 public immutable localDomain;

    // ============ Public Storage ============

    // A monotonically increasing nonce for outbound unique message IDs.
    uint32 public nonce;
    // The latest dispatched message ID used for auth in post-dispatch hooks.
    bytes32 public latestDispatchedId;

    // The default ISM, used if the recipient fails to specify one.
    IInterchainSecurityModule public defaultIsm;

    // The default post dispatch hook, used for post processing of dispatched messages.
    IPostDispatchHook public defaultHook;

    // Mapping of message ID to delivery context that processed the message.
    struct Delivery {
        // address sender;
        IInterchainSecurityModule ism;
        // uint48 value?
        // uint48 timestamp?
    }
    mapping(bytes32 => Delivery) internal deliveries;

    // ============ Events ============

    /**
     * @notice Emitted when the default ISM is updated
     * @param module The new default ISM
     */
    event DefaultIsmSet(address indexed module);

    /**
     * @notice Emitted when the default hook is updated
     * @param hook The new default hook
     */
    event DefaultHookSet(address indexed hook);

    // ============ Constructor ============

    constructor(uint32 _localDomain, address _owner) {
        localDomain = _localDomain;
        _transferOwnership(_owner);
    }

    // ============ External Functions ============

    /**
     * @notice Sets the default ISM for the Mailbox.
     * @param _module The new default ISM. Must be a contract.
     */
    function setDefaultIsm(address _module) external onlyOwner {
        require(Address.isContract(_module), "!contract");
        defaultIsm = IInterchainSecurityModule(_module);
        emit DefaultIsmSet(_module);
    }

    function setDefaultHook(address _hook) external onlyOwner {
        require(Address.isContract(_hook), "!contract");
        defaultHook = IPostDispatchHook(_hook);
        emit DefaultHookSet(_hook);
    }

    /**
     * @notice Dispatches a message to the destination domain & recipient.
     * @param _destinationDomain Domain of destination chain
     * @param _recipientAddress Address of recipient on destination chain as bytes32
     * @param _messageBody Raw bytes content of message body
     * @return The message ID inserted into the Mailbox's merkle tree
     */
    function dispatch(
        uint32 _destinationDomain,
        bytes32 _recipientAddress,
        bytes calldata _messageBody
    ) external payable override returns (bytes32) {
        return
            dispatch(
                _destinationDomain,
                _recipientAddress,
                _messageBody,
                defaultHook,
                _messageBody[0:0]
            );
    }

    /**
     * @notice Dispatches a message to the destination domain & recipient.
     * @param destinationDomain Domain of destination chain
     * @param recipientAddress Address of recipient on destination chain as bytes32
     * @param messageBody Raw bytes content of message body
     * @param hookMetadata Metadata used by the post dispatch hook
     * @return The message ID inserted into the Mailbox's merkle tree
     */
    function dispatch(
        uint32 destinationDomain,
        bytes32 recipientAddress,
        bytes calldata messageBody,
        bytes calldata hookMetadata
    ) external payable override returns (bytes32) {
        return
            dispatch(
                destinationDomain,
                recipientAddress,
                messageBody,
                defaultHook,
                hookMetadata
            );
    }

    function dispatch(
        uint32 destinationDomain,
        bytes32 recipientAddress,
        bytes calldata messageBody,
        IPostDispatchHook hook,
        bytes calldata metadata
    ) public payable returns (bytes32) {
        /// CHECKS ///

        // Format the message into packed bytes.
        bytes memory message = Message.formatMessage(
            VERSION,
            nonce,
            localDomain,
            msg.sender.addressToBytes32(),
            destinationDomain,
            recipientAddress,
            messageBody
        );
        bytes32 id = message.id();

        /// EFFECTS ///

        nonce += 1;
        latestDispatchedId = id;
        emit DispatchId(id);
        emit Dispatch(message);

        /// INTERACTIONS ///

        hook.postDispatch{value: msg.value}(metadata, message);

        return id;
    }

    function delivered(bytes32 _id) public view override returns (bool) {
        return address(deliveries[_id].ism) != address(0);
    }

    /**
     * @notice Attempts to deliver `_message` to its recipient. Verifies
     * `_message` via the recipient's ISM using the provided `_metadata`.
     * @param _metadata Metadata used by the ISM to verify `_message`.
     * @param _message Formatted Hyperlane message (refer to Message.sol).
     */
    function process(bytes calldata _metadata, bytes calldata _message)
        external
        payable
        override
    {
        /// CHECKS ///

        // Check that the message was intended for this mailbox.
        require(_message.version() == VERSION, "bad version");
        require(
            _message.destination() == localDomain,
            "unexpected destination"
        );

        // Check that the message hasn't already been delivered.
        bytes32 _id = _message.id();
        require(delivered(_id) == false, "already delivered");

        // Get the recipient's ISM.
        address recipient = _message.recipientAddress();
        IInterchainSecurityModule ism = recipientIsm(recipient);

        /// EFFECTS ///

        deliveries[_id] = Delivery({
            ism: ism
            // sender: msg.sender
            // value: uint48(msg.value),
            // timestamp: uint48(block.number)
        });
        emit Process(_message);
        emit ProcessId(_id);

        /// INTERACTIONS ///

        // Verify the message via the ISM.
        require(ism.verify(_metadata, _message), "verification failed");

        // Deliver the message to the recipient.
        IMessageRecipient(recipient).handle{value: msg.value}(
            _message.origin(),
            _message.sender(),
            _message.body()
        );
    }

    // ============ Public Functions ============

    /**
     * @notice Returns the ISM to use for the recipient, defaulting to the
     * default ISM if none is specified.
     * @param _recipient The message recipient whose ISM should be returned.
     * @return The ISM to use for `_recipient`.
     */
    function recipientIsm(address _recipient)
        public
        view
        returns (IInterchainSecurityModule)
    {
        // Use a default interchainSecurityModule if one is not specified by the
        // recipient.
        // This is useful for backwards compatibility and for convenience as
        // recipients are not mandated to specify an ISM.
        try
            ISpecifiesInterchainSecurityModule(_recipient)
                .interchainSecurityModule()
        returns (IInterchainSecurityModule _val) {
            // If the recipient specifies a zero address, use the default ISM.
            if (address(_val) != address(0)) {
                return _val;
            }
            // solhint-disable-next-line no-empty-blocks
        } catch {}
        return defaultIsm;
    }
}
