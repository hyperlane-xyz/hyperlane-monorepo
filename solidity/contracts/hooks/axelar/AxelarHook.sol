// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IPostDispatchHook} from "../../interfaces/hooks/IPostDispatchHook.sol";
import {StandardHookMetadata} from "../libs/StandardHookMetadata.sol";
import {BridgeAggregationHookMetadata} from "../libs/BridgeAggregationHookMetadata.sol";

import {Message} from "../../libs/Message.sol";
import {MailboxClient} from "../../client/MailboxClient.sol";

//TODO: remove temp intermal import. for testing speed purposes only
interface IAxelarGateway {
    function callContract(
        string calldata destinationChain,
        string calldata destinationContractAddress,
        bytes calldata payload
    ) external;
}

interface IAxelarGasService {
    function payNativeGasForContractCall(
        address sender,
        string calldata destinationChain,
        string calldata destinationAddress,
        bytes calldata payload,
        address refundAddress
    ) external payable;
}

contract AxelarHook is IPostDispatchHook, MailboxClient {
    using StandardHookMetadata for bytes;
    using BridgeAggregationHookMetadata for bytes;
    using Message for bytes;

    IAxelarGasService public immutable AXELAR_GAS_SERVICE;
    IAxelarGateway public immutable AXELAR_GATEWAY;
    string public DESTINATION_CHAIN;
    string public DESTINATION_CONTRACT;
    bytes GMP_CALL_DATA;

    constructor(
        address _mailbox,
        string memory destinationChain,
        string memory destionationContract,
        address axelarGateway,
        address axelarGasReceiver,
        bytes memory gmp_call_data
    ) MailboxClient(_mailbox) {
        DESTINATION_CHAIN = destinationChain;
        DESTINATION_CONTRACT = destionationContract;
        AXELAR_GATEWAY = IAxelarGateway(axelarGateway);
        AXELAR_GAS_SERVICE = IAxelarGasService(axelarGasReceiver);
        GMP_CALL_DATA = gmp_call_data;
    }

    /**
     * @notice Returns an enum that represents the type of hook
     */
    function hookType() external pure returns (uint8) {
        return uint8(IPostDispatchHook.Types.AXELAR);
    }

    /**
     * @notice Returns whether the hook supports metadata
     * @return true the hook supports metadata
     */
    function supportsMetadata(bytes calldata) external pure returns (bool) {
        return true;
    }

    function postDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) external payable {
        // ensure hook only dispatches messages that are dispatched by the mailbox
        bytes32 id = message.id();
        require(_isLatestDispatched(id), "message not dispatched by mailbox");

        bytes memory axelarPayload = _formatPayload(message);
        // Pay for gas used by Axelar with ETH
        AXELAR_GAS_SERVICE.payNativeGasForContractCall{value: msg.value}(
            address(this),
            DESTINATION_CHAIN,
            DESTINATION_CONTRACT,
            axelarPayload,
            metadata.refundAddress(address(0))
        );

        // bridging call
        AXELAR_GATEWAY.callContract(
            DESTINATION_CHAIN,
            DESTINATION_CONTRACT,
            axelarPayload
        );
    }

    /**
     * @notice Post action after a message is dispatched via the Mailbox
     * @param metadata The metadata required for the hook. Metadata should contain custom metadata
     *                 adhering to the BridgeAggregationHookMetadata structure.
     */
    function quoteDispatch(
        bytes calldata metadata,
        bytes calldata
    ) external pure returns (uint256) {
        bytes calldata bridgeMetadata = metadata.getCustomMetadata();

        uint256 quote = bridgeMetadata.axelarGasPayment();
        require(quote > 0, "No Axelar Payment Received");

        return quote;
    }

    function _formatPayload(
        bytes calldata message
    ) internal view returns (bytes memory) {
        return abi.encodePacked(GMP_CALL_DATA, message.id());
    }
}
