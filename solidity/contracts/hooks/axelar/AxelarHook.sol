// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IPostDispatchHook} from "../../interfaces/hooks/IPostDispatchHook.sol";
import {StandardHookMetadata} from "../libs/StandardHookMetadata.sol";
import {Message} from "../../libs/Message.sol";

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

contract AxelarHook is IPostDispatchHook {
    using StandardHookMetadata for bytes;
    using Message for bytes;

    IAxelarGasService public immutable AXELAR_GAS_SERVICE;
    IAxelarGateway public immutable AXELAR_GATEWAY;
    string public DESTINATION_CHAIN;
    string public DESTINATION_CONTRACT;
    bytes GMP_CALL_CODE;

    constructor(
        string memory destinationChain,
        string memory destionationContract,
        address axelarGateway,
        address axelarGasReceiver,
        bytes memory gmp_call_code
    ) {
        DESTINATION_CHAIN = destinationChain;
        DESTINATION_CONTRACT = destionationContract;
        AXELAR_GATEWAY = IAxelarGateway(axelarGateway);
        AXELAR_GAS_SERVICE = IAxelarGasService(axelarGasReceiver);
        GMP_CALL_CODE = gmp_call_code;
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
     *                 for the gas amount owed to the Axelar Gas Service.
     */
    function quoteDispatch(
        bytes calldata metadata,
        bytes calldata
    ) external pure returns (uint256) {
        bytes calldata customMetadata = metadata.getCustomMetadata();
        // Ensure that the custom metadata is of the correct size

        require(customMetadata.length <= 32, "Custom metadata is too large");
        require(
            customMetadata.length > 0,
            "Empty custom metadata. Axelar needs payment."
        );

        uint256 quote;
        assembly {
            // Copy the custom metadata to memory
            // The '0x20' adds an offset for the length field in memory
            calldatacopy(0x20, customMetadata.offset, customMetadata.length)
            // Load the data from memory into 'number'
            quote := mload(0x20)
        }

        require(quote > 0, "Custom Metadata cannot be zero value");

        return quote;
    }

    function _formatPayload(
        bytes calldata message
    ) internal view returns (bytes memory) {
        return abi.encodePacked(GMP_CALL_CODE, message.id());
    }
}
