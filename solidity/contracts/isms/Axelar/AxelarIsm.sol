// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {Message} from "../../libs/Message.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IAxelarGateway {
    function validateContractCall(
        bytes32 commandId,
        string calldata sourceChain,
        string calldata sourceAddress,
        bytes32 payloadHash
    ) external returns (bool);
}

contract AxelarIsm is IInterchainSecurityModule, Ownable {
    using Message for bytes;

    IAxelarGateway public AXELAR_GATEWAY;
    string public SOURCE_CHAIN;
    string public SOURCE_ADDRESS;

    mapping(bytes32 => bool) public validated;

    /**
     * @notice Initializes the hook with specific targets
     */
    function initializeSource(
        string memory sourceChain,
        string memory sourceAddress,
        address axelarGateway
    ) external onlyOwner {
        // require(
        //     bytes(SOURCE_CHAIN).length == 0 &&
        //     bytes(SOURCE_ADDRESS).length == 0,
        //     "Already initialized"
        // );
        SOURCE_CHAIN = sourceChain;
        SOURCE_ADDRESS = sourceAddress;
        AXELAR_GATEWAY = IAxelarGateway(axelarGateway);
    }

    /**
     * @notice Returns an enum that represents the type of hook
     */
    function moduleType() external pure returns (uint8) {
        return uint8(IInterchainSecurityModule.Types.AXELAR);
    }

    /**
     * @notice Verifies that an encoded VM is validand marks the internal
     * payload as processed. the payload should be the hyperlane message ID.
     * @param commandId Axelar Specific unique command ID
     * @param sourceChain Source chain where the call was iniitated from
     * @param sourceAddress Source address that initiated the call
     * @param payload the gmp payload.
     */
    function execute(
        bytes32 commandId,
        string calldata sourceChain,
        string calldata sourceAddress,
        bytes calldata payload
    ) external {
        bytes32 payloadHash = keccak256(payload);
        if (
            !AXELAR_GATEWAY.validateContractCall(
                commandId,
                sourceChain,
                sourceAddress,
                payloadHash
            )
        ) revert("Not approved by Axelar Gateway");

        // only accept calls from specific sournce chain and address.
        require(
            _compareStrings(sourceChain, SOURCE_CHAIN),
            "Unexpected Axelar source chain"
        );
        require(
            _compareStrings(sourceAddress, SOURCE_ADDRESS),
            "Unexpected Axelar source address"
        );

        //get hyperlane ID, decode into bytes32 from byte array
        bytes32 hyperlaneId = abi.decode(payload, (bytes32));
        validated[hyperlaneId] = true;
    }

    /**
     * @notice verifies interchain messages processed by Axelar.
     * @param _message Hyperlane encoded interchain message
     * @return true if the message was verified. false otherwise
     */
    function verify(
        bytes calldata,
        bytes calldata _message
    ) external view returns (bool) {
        return validated[_message.id()];
    }

    // ============ Helper Functions ============

    /**
     * @notice checks 2 strings for equality.
     * @param str1 First string.
     * @param str2 Second string.
     * @return true if the strings are equal. False otherwise.
     */
    function _compareStrings(
        string calldata str1,
        string memory str2
    ) internal pure returns (bool) {
        return
            keccak256(abi.encodePacked(str1)) ==
            keccak256(abi.encodePacked(str2));
    }
}
