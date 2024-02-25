// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

// ============ Internal Imports ============
import {MailboxClient} from "../client/MailboxClient.sol";
import {StandardHookMetadata} from "./libs/StandardHookMetadata.sol";
import {Message} from "../libs/Message.sol";

// ============ External Imports ============
import {IRouterClient} from "@chainlink/contracts-ccip/src/v0.8/ccip/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/src/v0.8/ccip/libraries/Client.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title CCIPHook
 * @notice Message hook to inform the CCIP of messages published through CCIP.
 */
contract CCIPHook is MailboxClient {
    using StandardHookMetadata for bytes;
    using Message for bytes;

    // ============ Errors ============

    error NotEnoughBalance(uint256 currentBalance, uint256 calculatedFees); // Used to make sure contract has enough balance.
    error DestinationChainNotAllowlisted(uint64 destinationChainSelector); // Used when the destination chain has not been allowlisted by the contract owner.

    // ============ Events ============

    event MessageSent(
        bytes32 indexed messageId, // The unique ID of the CCIP message.
        uint64 indexed destinationChainSelector, // The chain selector of the destination chain.
        address receiver, // The address of the receiver on the destination chain.
        bytes callData, // The payload being sent
        address feeToken, // the token address used to pay CCIP fees.
        uint256 fees // The fees paid for sending the CCIP message.
    );

    // ============ Storage ============

    mapping(uint64 => bool) public allowlistedDestinationChains;
    IRouterClient internal immutable ccip_router;
    address public ccipISM; // The address of CCIP Ism to call during ccipReceive

    // ============ Constructor ============

    /// @notice Constructor initializes the contract with the router address.
    /// @param _router The address of the CCIP router contract.
    constructor(
        address _router,
        address _mailbox
    )
        MailboxClient(_mailbox) {
        ccip_router = IRouterClient(_router);
    }

    // ============ Modifiers ============

    /// @dev Modifier that checks if the chain with the given destinationChainSelector is allowlisted.
    /// @param _destinationChainSelector The selector of the destination chain.
    modifier onlyAllowlistedDestinationChain(uint64 _destinationChainSelector) {
        if (!allowlistedDestinationChains[_destinationChainSelector])
            revert DestinationChainNotAllowlisted(_destinationChainSelector);
        _;
    }

    // ============ Internal functions ============

    /// @notice Construct a CCIP message.
    /// @dev This function will create an EVM2AnyMessage struct with all the necessary information for sending a text.
    /// @param _receiver The address of the receiver.
    /// @param _callData The string data to be sent.
    /// @param _feeTokenAddress The address of the token used for fees. Set address(0) for native gas.
    /// @return Client.EVM2AnyMessage Returns an EVM2AnyMessage struct which contains information for sending a CCIP message.
    function _buildCCIPMessage(
        address _receiver,
        bytes memory _callData,
        address _feeTokenAddress
    ) internal pure returns (Client.EVM2AnyMessage memory) {
        // Create an EVM2AnyMessage struct in memory with necessary information for sending a cross-chain message
        return
            Client.EVM2AnyMessage({
                receiver: abi.encode(_receiver), // ABI-encoded receiver address
                data: abi.encode(_callData), // ABI-encoded payload
                tokenAmounts: new Client.EVMTokenAmount[](0), // Empty array as no tokens are transferred
                extraArgs: "",
                // Set the feeToken to a feeTokenAddress, indicating specific asset will be used for fees
                feeToken: _feeTokenAddress
            });
    }

    /// @notice Sends data to receiver on the destination chain.
    /// @notice Pay for fees in native gas.
    /// @dev Assumes your contract has sufficient native gas tokens.
    /// @param _destinationChainSelector The identifier (aka selector) for the destination blockchain.
    /// @param _receiver The address of the recipient on the destination blockchain.
    /// @param _callData The text to be sent.
    /// @return messageId The ID of the CCIP message that was sent.
    function _sendMessagePayNative(
        uint64 _destinationChainSelector,
        address _receiver,
        bytes memory _callData
    )
        internal
        onlyAllowlistedDestinationChain(_destinationChainSelector)
        returns (bytes32 messageId)
    {
        // Create an EVM2AnyMessage struct in memory with necessary information for sending a cross-chain message
        Client.EVM2AnyMessage memory evm2AnyMessage = _buildCCIPMessage(
            _receiver,
            _callData,
            address(0)
        );

        // Get the fee required to send the CCIP message
        uint256 fees = ccip_router.getFee(_destinationChainSelector, evm2AnyMessage);

        if (fees > msg.value)
            revert NotEnoughBalance(address(this).balance, fees);

        // Send the CCIP message through the router and store the returned CCIP message ID
        messageId = ccip_router.ccipSend{value: fees}(
            _destinationChainSelector,
            evm2AnyMessage
        );

        // Emit an event with message details
        emit MessageSent(
            messageId,
            _destinationChainSelector,
            _receiver,
            _callData,
            address(0),
            fees
        );

        // Return the CCIP message ID
        return messageId;
    }

    // ============ Public / External functions ============

    /// @notice Calculates the cost in native currency for the call
    /// @param metadata StandardHookMetadata, which contains necessary data for CCIP message formation
    /// @param message Hyperlane Message 
    /// @return Minimum wei required for this CCIP call
    function quoteDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) public view returns (uint256) {
        // Retrieve custom metadata, which forms the CCIP message input
        bytes memory customMetadata = metadata.getCustomMetadata();
        (uint64 destinationChainSelector, address receiver) = abi.decode(customMetadata, (uint64, address));
        bytes32 _id = message.id();
        bytes memory callData = abi.encode(_id);
        // Create an EVM2AnyMessage struct in memory with necessary information for sending a cross-chain message
        Client.EVM2AnyMessage memory evm2AnyMessage = _buildCCIPMessage(
            receiver,
            callData,
            address(0)
        );

        // Get the fee required to send the CCIP message
        uint256 fees = ccip_router.getFee(destinationChainSelector, evm2AnyMessage);

        return fees;
    }

    function postDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) external payable {
        bytes32 id = message.id();
        require(
            _isLatestDispatched(id),
            "CCIPHook: message not latest dispatched"
        );
        
        bytes memory customMetadata = metadata.getCustomMetadata();
        (uint64 destinationChainSelector, address receiver) = abi.decode(customMetadata, (uint64, address));
        bytes memory payload = abi.encode(id);

        _sendMessagePayNative(destinationChainSelector, receiver, payload);
    }

    /// @dev Updates the allowlist status of a destination chain for transactions.
    /// @param _destinationChainSelector the Chainlink specified destitation chain selector
    /// @param allowed true to add new chain
    function addDestinationChainToAllowlist(
        uint64 _destinationChainSelector,
        bool allowed
    ) external onlyOwner {
        allowlistedDestinationChains[_destinationChainSelector] = allowed;
    }

    /// @dev Sets the address for Ism to verify message
    function setIsm(address _ism) external onlyOwner {
        ccipISM = _ism;
    }
}
