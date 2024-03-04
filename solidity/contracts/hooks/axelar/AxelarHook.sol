// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IPostDispatchHook} from "../../interfaces/hooks/IPostDispatchHook.sol";
import {StandardHookMetadata} from "../libs/StandardHookMetadata.sol";
import {Message} from "../../libs/Message.sol";
import {IMailbox} from "../../interfaces/IMailbox.sol";

// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AddressToString} from "../../libs/AddressString.sol";

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
interface IAxelarHookGasService {
    function getGas() external view returns (uint256);
}

contract AxelarHookGasService is Ownable {
    uint256 public gas;
    function setGas(uint256 _newGas) external onlyOwner {
        gas = _newGas;
    }
    function getGas() external view returns (uint256) {
        return gas;
    }
}

contract AxelarHook is IPostDispatchHook, Ownable {
    using StandardHookMetadata for bytes;
    using Message for bytes;
    using AddressToString for address;

    IMailbox public immutable MAILBOX;
    IAxelarGasService public immutable AXELAR_GAS_SERVICE;
    IAxelarGateway public immutable AXELAR_GATEWAY;
    IAxelarHookGasService public immutable AXELAR_HOOK_GAS;
    string public DESTINATION_CHAIN;
    string public DESTINATION_CONTRACT;

    constructor(
        address _mailbox,
        address axelarGateway,
        address axelarGasReceiver,
        address axelarHookGasService
    ) {
        MAILBOX = IMailbox(_mailbox);
        AXELAR_GATEWAY = IAxelarGateway(axelarGateway);
        AXELAR_GAS_SERVICE = IAxelarGasService(axelarGasReceiver);
        AXELAR_HOOK_GAS = IAxelarHookGasService(axelarHookGasService);
    }

    /**
     * @notice Initializes the hook with specific targets
     */
    function initializeReceiver(
        string memory destinationChain,
        string memory destionationContract
    ) external onlyOwner {
        // require(
        //     bytes(DESTINATION_CHAIN).length == 0 &&
        //     bytes(DESTINATION_CONTRACT).length == 0,
        //     "Already initialized"
        // );
        DESTINATION_CHAIN = destinationChain;
        DESTINATION_CONTRACT = destionationContract;
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

        bytes memory axelarPayload = _encodeGmpPayload(id);

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
     * @notice Quote for the amount of value required to run this hook.
     */
    function quoteDispatch(
        bytes calldata,
        bytes calldata
    ) external view returns (uint256) {
        return AXELAR_HOOK_GAS.getGas();
    }

    /**
     * @notice Helper function to encode the Axelar GMP payload
     * @param _id The latest id of the current dispatched hyperlane message
     * @return bytes The Axelar GMP payload.
     */
    function _encodeGmpPayload(bytes32 _id) internal returns (bytes memory) {
        // dociding version used by Axelar
        bytes4 version = bytes4(uint32(1));

        //name of the arguments used in the cross-chain function call
        string[] memory argumentNameArray = new string[](3);
        argumentNameArray[0] = "origin_address";
        argumentNameArray[1] = "origin_chain";
        argumentNameArray[2] = "id";
        // type of argument used in the cross-chain function call
        string[] memory abiTypeArray = new string[](3);
        abiTypeArray[0] = "string";
        abiTypeArray[1] = "string";
        abiTypeArray[2] = "bytes32";

        // message argument
        bytes memory argValue = abi.encode(
            address(this).toString(),
            "ethereum-sepolia",
            _id
        );

        // add the function name: (submit_meta) and argument value (_id)
        bytes memory gmpPayload = abi.encode(
            "submit_meta",
            argumentNameArray,
            abiTypeArray,
            argValue
        );

        // encode the version and return the payload
        return
            abi.encodePacked(
                version, // version number
                gmpPayload
            );
    }

    /**
     * @notice Helper function to check wether an ID is the latest dispatched by Mailbox
     * @param _id The id to check.
     * @return true if latest, false otherwise.
     */
    function _isLatestDispatched(bytes32 _id) internal view returns (bool) {
        return MAILBOX.latestDispatchedId() == _id;
    }
}
