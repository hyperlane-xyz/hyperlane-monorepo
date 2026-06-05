// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {IWormhole} from "../../contracts/interfaces/IWormhole.sol";
import {ICcipReadIsm} from "../../contracts/interfaces/isms/ICcipReadIsm.sol";
import {WormholeIsm, WormholeVaaService} from "../../contracts/isms/hook/WormholeIsm.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";
import {MessageUtils} from "./IsmTestUtils.sol";
import {MockWormhole} from "../hooks/MockWormhole.sol";

contract WormholeIsmTest is Test {
    using TypeCasts for address;
    using MessageUtils for bytes;

    uint32 internal constant ORIGIN_DOMAIN = 1;
    uint32 internal constant DESTINATION_DOMAIN = 2;
    uint16 internal constant EMITTER_CHAIN = 4; // e.g. BSC in Wormhole ids
    bytes32 internal constant EMITTER_ADDRESS =
        bytes32(uint256(uint160(0x1234)));

    address internal owner = address(0xABCD);

    MockWormhole internal wormhole;
    WormholeIsm internal ism; // implementation, used for verify() tests
    WormholeIsm internal proxiedIsm; // proxy, initialized, for urls/lookup
    TestRecipient internal recipient;

    string[] internal urls;
    bytes internal encodedMessage;
    bytes32 internal messageId;

    function setUp() public {
        recipient = new TestRecipient();
        wormhole = new MockWormhole(0, EMITTER_CHAIN);
        ism = new WormholeIsm(
            address(wormhole),
            EMITTER_CHAIN,
            EMITTER_ADDRESS
        );

        urls = new string[](1);
        urls[0] = "https://ccip-server.hyperlane.xyz";

        WormholeIsm impl = new WormholeIsm(
            address(wormhole),
            EMITTER_CHAIN,
            EMITTER_ADDRESS
        );
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(WormholeIsm.initialize, (owner, urls))
        );
        proxiedIsm = WormholeIsm(address(proxy));

        encodedMessage = _encodeMessage();
        messageId = Message.id(encodedMessage);
    }

    /* ============ constructor ============ */

    function test_constructor_revertsWhen_zeroWormhole() public {
        vm.expectRevert("WormholeIsm: invalid wormhole");
        new WormholeIsm(address(0), EMITTER_CHAIN, EMITTER_ADDRESS);
    }

    function test_constructor_revertsWhen_zeroEmitter() public {
        vm.expectRevert("WormholeIsm: invalid emitter");
        new WormholeIsm(address(wormhole), EMITTER_CHAIN, bytes32(0));
    }

    function test_immutables() public view {
        assertEq(address(ism.wormhole()), address(wormhole));
        assertEq(ism.emitterChainId(), EMITTER_CHAIN);
        assertEq(ism.emitterAddress(), EMITTER_ADDRESS);
    }

    /* ============ verify ============ */

    function test_verify_succeeds() public view {
        bytes memory metadata = _metadata(
            EMITTER_CHAIN,
            EMITTER_ADDRESS,
            abi.encode(messageId)
        );
        assertTrue(ism.verify(metadata, encodedMessage));
    }

    function test_verify_revertsWhen_invalidVaa() public {
        wormhole.setVmValid(false, "VM signature invalid");
        bytes memory metadata = _metadata(
            EMITTER_CHAIN,
            EMITTER_ADDRESS,
            abi.encode(messageId)
        );
        vm.expectRevert("VM signature invalid");
        ism.verify(metadata, encodedMessage);
    }

    function test_verify_revertsWhen_wrongEmitterChain() public {
        bytes memory metadata = _metadata(
            EMITTER_CHAIN + 1,
            EMITTER_ADDRESS,
            abi.encode(messageId)
        );
        vm.expectRevert("WormholeIsm: wrong emitter chain");
        ism.verify(metadata, encodedMessage);
    }

    function test_verify_revertsWhen_wrongEmitterAddress() public {
        bytes memory metadata = _metadata(
            EMITTER_CHAIN,
            bytes32(uint256(uint160(0xdead))),
            abi.encode(messageId)
        );
        vm.expectRevert("WormholeIsm: wrong emitter address");
        ism.verify(metadata, encodedMessage);
    }

    function test_verify_revertsWhen_messageIdMismatch() public {
        bytes memory metadata = _metadata(
            EMITTER_CHAIN,
            EMITTER_ADDRESS,
            abi.encode(keccak256("not the message id"))
        );
        vm.expectRevert("WormholeIsm: message id mismatch");
        ism.verify(metadata, encodedMessage);
    }

    /* ============ getOffchainVerifyInfo ============ */

    function test_getOffchainVerifyInfo_revertsWithLookup() public {
        bytes memory expected = abi.encodeWithSelector(
            ICcipReadIsm.OffchainLookup.selector,
            address(proxiedIsm),
            urls,
            abi.encodeCall(WormholeVaaService.getVaa, (encodedMessage)),
            proxiedIsm.verify.selector,
            encodedMessage
        );
        vm.expectRevert(expected);
        proxiedIsm.getOffchainVerifyInfo(encodedMessage);
    }

    /* ============ urls ============ */

    function test_initialize_setsOwnerAndUrls() public view {
        assertEq(proxiedIsm.owner(), owner);
        assertEq(proxiedIsm.urls()[0], urls[0]);
    }

    function test_setUrls_revertsWhen_notOwner() public {
        string[] memory newUrls = new string[](1);
        newUrls[0] = "https://evil.xyz";
        vm.expectRevert("Ownable: caller is not the owner");
        proxiedIsm.setUrls(newUrls);
    }

    function test_setUrls_updatesUrls() public {
        string[] memory newUrls = new string[](1);
        newUrls[0] = "https://new.hyperlane.xyz";
        vm.prank(owner);
        proxiedIsm.setUrls(newUrls);
        assertEq(proxiedIsm.urls()[0], "https://new.hyperlane.xyz");
    }

    /* ============ helpers ============ */

    function _metadata(
        uint16 _emitterChain,
        bytes32 _emitterAddress,
        bytes memory _payload
    ) internal pure returns (bytes memory) {
        IWormhole.VM memory vm_;
        vm_.emitterChainId = _emitterChain;
        vm_.emitterAddress = _emitterAddress;
        vm_.payload = _payload;
        bytes memory vaa = abi.encode(vm_);
        return abi.encode(vaa);
    }

    function _encodeMessage() internal view returns (bytes memory) {
        return
            MessageUtils.formatMessage(
                1,
                0,
                ORIGIN_DOMAIN,
                address(this).addressToBytes32(),
                DESTINATION_DOMAIN,
                address(recipient).addressToBytes32(),
                "body"
            );
    }
}
