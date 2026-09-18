// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.20;

import {MessagingFee as LayerZeroMessagingFee, MessagingParams as LayerZeroMessagingParams, MessagingReceipt as LayerZeroMessagingReceipt, Origin as LayerZeroOrigin} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {ILayerZeroReceiver} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroReceiver.sol";
import {SetConfigParam as LayerZeroSetConfigParam} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/IMessageLibManager.sol";
import {GUID} from "@layerzerolabs/lz-evm-protocol-v2/contracts/libs/GUID.sol";
import {Errors} from "@layerzerolabs/lz-evm-protocol-v2/contracts/libs/Errors.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";

contract MockLayerZeroEndpointV2 {
    using TypeCasts for address;

    struct ReceiveLibraryTimeout {
        address libraryAddress;
        uint256 expiry;
    }

    uint32 public immutable eid;
    address public immutable blockedLibrary;
    address public nativeToken;
    uint256 public constant nativeFee = 0.01 ether;
    uint256 public lzTokenFee;
    bytes public lastPacket;
    bytes public lastOptions;

    mapping(address => bool) public registeredLibraries;
    mapping(uint32 => address) public defaultReceiveLibraries;
    mapping(address => mapping(uint32 => address)) public sendLibraries;
    mapping(address => mapping(uint32 => address)) public receiveLibraries;
    mapping(address => mapping(uint32 => ReceiveLibraryTimeout))
        public receiveLibraryTimeout;
    mapping(address => mapping(address => mapping(uint32 => mapping(uint32 => bytes))))
        public configs;
    mapping(address => mapping(uint32 => mapping(bytes32 => mapping(uint64 => bytes32))))
        public payloadHashes;
    mapping(address => mapping(uint32 => mapping(bytes32 => uint64)))
        public lazyInboundNonce;
    mapping(address => mapping(uint32 => mapping(bytes32 => uint64)))
        public outboundNonces;

    error Unauthorized();
    error InvalidPayloadHash();
    error SameValue();
    error OnlyNonDefaultLibrary();
    error InvalidExpiry();

    event PacketSent(bytes encodedPayload, bytes options, address sendLibrary);

    constructor(uint32 _endpointId) {
        eid = _endpointId;
        blockedLibrary = address(0xB10C);
        registeredLibraries[blockedLibrary] = true;
    }

    function setNativeToken(address token) external {
        nativeToken = token;
    }

    function setLzTokenFee(uint256 fee) external {
        lzTokenFee = fee;
    }

    function registerMockLibrary(address libraryAddress) external {
        registeredLibraries[libraryAddress] = true;
    }

    function setDefaultReceiveLibrary(
        uint32 sourceEndpointId,
        address libraryAddress
    ) external {
        defaultReceiveLibraries[sourceEndpointId] = libraryAddress;
    }

    function quote(
        LayerZeroMessagingParams calldata,
        address
    ) external view returns (LayerZeroMessagingFee memory) {
        return
            LayerZeroMessagingFee({
                nativeFee: nativeFee,
                lzTokenFee: lzTokenFee
            });
    }

    function send(
        LayerZeroMessagingParams calldata params,
        address
    ) external payable returns (LayerZeroMessagingReceipt memory receipt) {
        require(msg.value >= nativeFee, "fee");
        uint64 nonce = ++outboundNonces[msg.sender][params.dstEid][
            params.receiver
        ];
        bytes32 sender = msg.sender.addressToBytes32();
        bytes32 guid = GUID.generate(
            nonce,
            eid,
            msg.sender,
            params.dstEid,
            params.receiver
        );
        lastPacket = abi.encodePacked(
            uint8(1),
            nonce,
            eid,
            sender,
            params.dstEid,
            params.receiver,
            guid,
            params.message
        );
        lastOptions = params.options;
        emit PacketSent(
            lastPacket,
            params.options,
            sendLibraries[msg.sender][params.dstEid]
        );
        receipt = LayerZeroMessagingReceipt({
            guid: guid,
            nonce: nonce,
            fee: LayerZeroMessagingFee({
                nativeFee: nativeFee,
                lzTokenFee: lzTokenFee
            })
        });
    }

    function clear(
        address oapp,
        LayerZeroOrigin calldata origin,
        bytes32 guid,
        bytes calldata message
    ) external {
        _authorize(oapp);
        _clear(oapp, origin, guid, message);
    }

    function mockExecute(
        address receiver,
        LayerZeroOrigin calldata origin,
        bytes32 guid,
        bytes calldata message
    ) external {
        _clear(receiver, origin, guid, message);
        ILayerZeroReceiver(receiver).lzReceive(
            origin,
            guid,
            message,
            msg.sender,
            ""
        );
    }

    function _clear(
        address oapp,
        LayerZeroOrigin calldata origin,
        bytes32 guid,
        bytes calldata message
    ) internal {
        uint64 currentNonce = lazyInboundNonce[oapp][origin.srcEid][
            origin.sender
        ];
        if (origin.nonce > currentNonce) {
            // Endpoint V2 only clears packets in nonce order, even when an OApp
            // opts into unordered verification by returning zero from nextNonce.
            for (uint64 i = currentNonce + 1; i <= origin.nonce; ++i) {
                if (
                    payloadHashes[oapp][origin.srcEid][origin.sender][i] ==
                    bytes32(0)
                ) revert Errors.LZ_InvalidNonce(i);
            }
            lazyInboundNonce[oapp][origin.srcEid][origin.sender] = origin.nonce;
        }
        bytes32 expected = keccak256(abi.encodePacked(guid, message));
        bytes32 current = payloadHashes[oapp][origin.srcEid][origin.sender][
            origin.nonce
        ];
        if (current != expected) revert InvalidPayloadHash();
        delete payloadHashes[oapp][origin.srcEid][origin.sender][origin.nonce];
    }

    function mockVerify(
        address receiver,
        uint32 sourceEndpointId,
        bytes32 sender,
        uint64 nonce,
        bytes32 payloadHash
    ) external {
        require(registeredLibraries[msg.sender], "library");
        payloadHashes[receiver][sourceEndpointId][sender][nonce] = payloadHash;
    }

    function inboundPayloadHash(
        address receiver,
        uint32 sourceEndpointId,
        bytes32 sender,
        uint64 nonce
    ) external view returns (bytes32) {
        return payloadHashes[receiver][sourceEndpointId][sender][nonce];
    }

    function isRegisteredLibrary(
        address libraryAddress
    ) external view returns (bool) {
        return registeredLibraries[libraryAddress];
    }

    function isValidReceiveLibrary(
        address receiver,
        uint32 sourceEndpointId,
        address libraryAddress
    ) external view returns (bool) {
        address selectedLibrary = receiveLibraries[receiver][sourceEndpointId];
        if (selectedLibrary == address(0)) {
            selectedLibrary = defaultReceiveLibraries[sourceEndpointId];
        }
        if (selectedLibrary != address(0) && selectedLibrary == libraryAddress)
            return true;
        ReceiveLibraryTimeout memory timeout = receiveLibraryTimeout[receiver][
            sourceEndpointId
        ];
        return
            timeout.libraryAddress == libraryAddress &&
            timeout.expiry > block.number;
    }

    function setSendLibrary(
        address oapp,
        uint32 destinationEndpointId,
        address newLibrary
    ) external {
        _authorize(oapp);
        if (sendLibraries[oapp][destinationEndpointId] == newLibrary)
            revert SameValue();
        sendLibraries[oapp][destinationEndpointId] = newLibrary;
    }

    function getSendLibrary(
        address sender,
        uint32 destinationEndpointId
    ) external view returns (address) {
        return sendLibraries[sender][destinationEndpointId];
    }

    function isDefaultSendLibrary(
        address sender,
        uint32 destinationEndpointId
    ) external view returns (bool) {
        return sendLibraries[sender][destinationEndpointId] == address(0);
    }

    function setReceiveLibrary(
        address oapp,
        uint32 sourceEndpointId,
        address newLibrary,
        uint256 gracePeriod
    ) external {
        _authorize(oapp);
        address oldLibrary = receiveLibraries[oapp][sourceEndpointId];
        if (oldLibrary == newLibrary) revert SameValue();
        if (
            gracePeriod != 0 &&
            (oldLibrary == address(0) || newLibrary == address(0))
        ) revert OnlyNonDefaultLibrary();
        receiveLibraries[oapp][sourceEndpointId] = newLibrary;
        if (gracePeriod == 0) {
            delete receiveLibraryTimeout[oapp][sourceEndpointId];
        } else {
            receiveLibraryTimeout[oapp][
                sourceEndpointId
            ] = ReceiveLibraryTimeout({
                libraryAddress: oldLibrary,
                expiry: block.number + gracePeriod
            });
        }
    }

    function getReceiveLibrary(
        address receiver,
        uint32 sourceEndpointId
    ) external view returns (address libraryAddress, bool isDefault) {
        libraryAddress = receiveLibraries[receiver][sourceEndpointId];
        if (libraryAddress == address(0)) {
            libraryAddress = defaultReceiveLibraries[sourceEndpointId];
            if (libraryAddress == address(0))
                revert Errors.LZ_DefaultReceiveLibUnavailable();
            isDefault = true;
        }
    }

    function setReceiveLibraryTimeout(
        address oapp,
        uint32 sourceEndpointId,
        address libraryAddress,
        uint256 expiry
    ) external {
        _authorize(oapp);
        if (expiry == 0) {
            delete receiveLibraryTimeout[oapp][sourceEndpointId];
        } else {
            if (expiry <= block.number) revert InvalidExpiry();
            receiveLibraryTimeout[oapp][
                sourceEndpointId
            ] = ReceiveLibraryTimeout({
                libraryAddress: libraryAddress,
                expiry: expiry
            });
        }
    }

    function setConfig(
        address oapp,
        address libraryAddress,
        LayerZeroSetConfigParam[] calldata params
    ) external {
        _authorize(oapp);
        for (uint256 i = 0; i < params.length; ++i) {
            configs[oapp][libraryAddress][params[i].eid][
                params[i].configType
            ] = params[i].config;
        }
    }

    function getConfig(
        address oapp,
        address libraryAddress,
        uint32 remoteEndpointId,
        uint32 configType
    ) external view returns (bytes memory) {
        return configs[oapp][libraryAddress][remoteEndpointId][configType];
    }

    function _authorize(address oapp) internal view {
        if (msg.sender != oapp) {
            revert Unauthorized();
        }
    }
}
