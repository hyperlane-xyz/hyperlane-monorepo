// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.20;

import {MessagingFee as LayerZeroMessagingFee, MessagingParams as LayerZeroMessagingParams, MessagingReceipt as LayerZeroMessagingReceipt, Origin as LayerZeroOrigin} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {ILayerZeroReceiver} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroReceiver.sol";
import {SetConfigParam as LayerZeroSetConfigParam} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/IMessageLibManager.sol";
import {GUID} from "@layerzerolabs/lz-evm-protocol-v2/contracts/libs/GUID.sol";

contract MockLayerZeroEndpointV2 {
    struct ReceiveLibraryTimeout {
        address libraryAddress;
        uint256 expiry;
    }

    uint32 public immutable eid;
    address public nativeToken;
    uint256 public nativeFee = 0.01 ether;
    bytes public lastPacket;
    bytes public lastOptions;

    mapping(address => address) public delegates;
    mapping(address => bool) public registeredLibraries;
    mapping(address => mapping(uint32 => address)) public sendLibraries;
    mapping(address => mapping(uint32 => address)) public receiveLibraries;
    mapping(address => mapping(uint32 => ReceiveLibraryTimeout))
        public receiveLibraryTimeout;
    mapping(address => mapping(address => mapping(uint32 => mapping(uint32 => bytes))))
        public configs;
    mapping(address => mapping(uint32 => mapping(bytes32 => mapping(uint64 => bytes32))))
        public payloadHashes;
    mapping(address => mapping(uint32 => mapping(bytes32 => uint64)))
        public outboundNonces;

    error Unauthorized();
    error InvalidPayloadHash();
    error SameValue();
    error OnlyNonDefaultLibrary();
    error InvalidExpiry();

    event PacketSent(bytes encodedPayload, bytes options, address sendLibrary);

    constructor(uint32 eid_) {
        eid = eid_;
    }

    function setNativeToken(address token) external {
        nativeToken = token;
    }

    function setNativeFee(uint256 fee) external {
        nativeFee = fee;
    }

    function registerMockLibrary(address libraryAddress) external {
        registeredLibraries[libraryAddress] = true;
    }

    function setDelegate(address delegate) external {
        delegates[msg.sender] = delegate;
    }

    function quote(
        LayerZeroMessagingParams calldata,
        address
    ) external view returns (LayerZeroMessagingFee memory) {
        return LayerZeroMessagingFee({nativeFee: nativeFee, lzTokenFee: 0});
    }

    function send(
        LayerZeroMessagingParams calldata params,
        address
    ) external payable returns (LayerZeroMessagingReceipt memory receipt) {
        require(msg.value >= nativeFee, "fee");
        uint64 nonce = ++outboundNonces[msg.sender][params.dstEid][
            params.receiver
        ];
        bytes32 sender = bytes32(uint256(uint160(msg.sender)));
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
            fee: LayerZeroMessagingFee({nativeFee: nativeFee, lzTokenFee: 0})
        });
    }

    function clear(
        address oapp,
        LayerZeroOrigin calldata origin,
        bytes32 guid,
        bytes calldata message
    ) external {
        _authorize(oapp);
        bytes32 expected = keccak256(abi.encodePacked(guid, message));
        bytes32 current = payloadHashes[oapp][origin.srcEid][origin.sender][
            origin.nonce
        ];
        if (current != expected) revert InvalidPayloadHash();
        delete payloadHashes[oapp][origin.srcEid][origin.sender][origin.nonce];
    }

    function mockVerify(
        address receiver,
        uint32 srcEid,
        bytes32 sender,
        uint64 nonce,
        bytes32 payloadHash
    ) external {
        require(registeredLibraries[msg.sender], "library");
        payloadHashes[receiver][srcEid][sender][nonce] = payloadHash;
    }

    function mockDeliver(
        address receiver,
        LayerZeroOrigin calldata origin,
        bytes32 guid,
        bytes calldata message
    ) external {
        ILayerZeroReceiver(receiver).lzReceive(
            origin,
            guid,
            message,
            msg.sender,
            ""
        );
    }

    function inboundPayloadHash(
        address receiver,
        uint32 srcEid,
        bytes32 sender,
        uint64 nonce
    ) external view returns (bytes32) {
        return payloadHashes[receiver][srcEid][sender][nonce];
    }

    function isRegisteredLibrary(
        address libraryAddress
    ) external view returns (bool) {
        return registeredLibraries[libraryAddress];
    }

    function isValidReceiveLibrary(
        address receiver,
        uint32 srcEid,
        address libraryAddress
    ) external view returns (bool) {
        if (receiveLibraries[receiver][srcEid] == libraryAddress) return true;
        ReceiveLibraryTimeout memory timeout = receiveLibraryTimeout[receiver][
            srcEid
        ];
        return
            timeout.libraryAddress == libraryAddress &&
            timeout.expiry > block.number;
    }

    function setSendLibrary(
        address oapp,
        uint32 dstEid,
        address newLibrary
    ) external {
        _authorize(oapp);
        if (sendLibraries[oapp][dstEid] == newLibrary) revert SameValue();
        sendLibraries[oapp][dstEid] = newLibrary;
    }

    function getSendLibrary(
        address sender,
        uint32 dstEid
    ) external view returns (address) {
        return sendLibraries[sender][dstEid];
    }

    function isDefaultSendLibrary(
        address sender,
        uint32 dstEid
    ) external view returns (bool) {
        return sendLibraries[sender][dstEid] == address(0);
    }

    function setReceiveLibrary(
        address oapp,
        uint32 srcEid,
        address newLibrary,
        uint256 gracePeriod
    ) external {
        _authorize(oapp);
        address oldLibrary = receiveLibraries[oapp][srcEid];
        if (oldLibrary == newLibrary) revert SameValue();
        if (
            gracePeriod != 0 &&
            (oldLibrary == address(0) || newLibrary == address(0))
        ) revert OnlyNonDefaultLibrary();
        receiveLibraries[oapp][srcEid] = newLibrary;
        if (gracePeriod == 0) {
            delete receiveLibraryTimeout[oapp][srcEid];
        } else {
            receiveLibraryTimeout[oapp][srcEid] = ReceiveLibraryTimeout({
                libraryAddress: oldLibrary,
                expiry: block.number + gracePeriod
            });
        }
    }

    function getReceiveLibrary(
        address receiver,
        uint32 srcEid
    ) external view returns (address libraryAddress, bool isDefault) {
        libraryAddress = receiveLibraries[receiver][srcEid];
        isDefault = libraryAddress == address(0);
    }

    function setReceiveLibraryTimeout(
        address oapp,
        uint32 srcEid,
        address libraryAddress,
        uint256 expiry
    ) external {
        _authorize(oapp);
        if (expiry == 0) {
            delete receiveLibraryTimeout[oapp][srcEid];
        } else {
            if (expiry <= block.number) revert InvalidExpiry();
            receiveLibraryTimeout[oapp][srcEid] = ReceiveLibraryTimeout({
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
        uint32 remoteEid,
        uint32 configType
    ) external view returns (bytes memory) {
        return configs[oapp][libraryAddress][remoteEid][configType];
    }

    function _authorize(address oapp) internal view {
        if (msg.sender != oapp && msg.sender != delegates[oapp]) {
            revert Unauthorized();
        }
    }
}
