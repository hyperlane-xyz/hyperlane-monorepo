// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.19;

import {Test} from "forge-std/Test.sol";

import {WormholeVaaHookIsm} from "contracts/hooks/wormhole/WormholeVaaHookIsm.sol";
import {WormholeConsistencyLevelConfig} from "contracts/hooks/wormhole/libs/CustomConsistencyLevel.sol";
import {IPostDispatchHook} from "contracts/interfaces/hooks/IPostDispatchHook.sol";
import {WormholeMessage} from "contracts/libs/WormholeMessage.sol";
import {Message} from "contracts/libs/Message.sol";
import {TypeCasts} from "contracts/libs/TypeCasts.sol";
import {MockWormholeCore} from "contracts/mock/MockWormholeCore.sol";
import {TestMailbox} from "contracts/test/TestMailbox.sol";
import {TestPostDispatchHook} from "contracts/test/TestPostDispatchHook.sol";
import {TestRecipient} from "contracts/test/TestRecipient.sol";

/**
 * @dev Stateful actions for publication, VAA verification, and unrelated route
 * churn. Reverts are swallowed so invariant runs continue exploring state.
 */
contract WormholeVaaHandler is Test {
    using Message for bytes;
    using TypeCasts for address;

    uint32 internal constant ORIGIN = 1000;
    uint32 internal constant DESTINATION = 2000;
    uint16 internal constant WH_ORIGIN = 2;
    uint8 internal constant CONSISTENCY = 202;
    uint256 internal constant CORE_FEE = 0.001 ether;

    TestMailbox internal immutable originMailbox;
    MockWormholeCore internal immutable originCore;
    WormholeVaaHookIsm internal immutable originRouter;
    WormholeVaaHookIsm internal immutable destinationRouter;
    address internal immutable recipient;

    bytes[] internal dispatchedMessages;
    uint256 public republishSuccesses;
    uint256 public invalidVerificationSuccesses;
    uint256 public validVerificationFailures;
    uint64 public publications;

    constructor(
        TestMailbox _originMailbox,
        MockWormholeCore _originCore,
        WormholeVaaHookIsm _originRouter,
        WormholeVaaHookIsm _destinationRouter,
        address _recipient
    ) {
        originMailbox = _originMailbox;
        originCore = _originCore;
        originRouter = _originRouter;
        destinationRouter = _destinationRouter;
        recipient = _recipient;
    }

    receive() external payable {}

    function dispatch() external {
        vm.deal(address(this), 10 ether);
        bytes memory message = originMailbox.buildOutboundMessage(
            DESTINATION,
            recipient.addressToBytes32(),
            "invariant"
        );

        try
            originMailbox.dispatch{value: CORE_FEE}(
                DESTINATION,
                recipient.addressToBytes32(),
                "invariant",
                "",
                IPostDispatchHook(address(originRouter))
            )
        {
            dispatchedMessages.push(message);
            publications += 1;
        } catch {}
    }

    function republishLatest() external {
        if (dispatchedMessages.length == 0) return;
        vm.deal(address(this), 10 ether);

        try
            IPostDispatchHook(address(originRouter)).postDispatch{
                value: CORE_FEE
            }("", dispatchedMessages[dispatchedMessages.length - 1])
        {
            republishSuccesses += 1;
        } catch {}
    }

    function verifyValid(uint256 seed) external {
        if (dispatchedMessages.length == 0) return;
        uint256 index = seed % dispatchedMessages.length;
        bytes memory message = dispatchedMessages[index];
        bytes memory metadata = _metadata(
            message,
            address(originRouter).addressToBytes32(),
            uint64(index)
        );

        try destinationRouter.verify(metadata, message) returns (bool valid) {
            if (!valid) validVerificationFailures += 1;
        } catch {
            validVerificationFailures += 1;
        }
    }

    function verifyInvalidEmitter(uint256 seed) external {
        if (dispatchedMessages.length == 0) return;
        uint256 index = seed % dispatchedMessages.length;
        bytes memory message = dispatchedMessages[index];
        bytes memory metadata = _metadata(
            message,
            address(0xdead).addressToBytes32(),
            uint64(index)
        );

        try destinationRouter.verify(metadata, message) returns (bool valid) {
            if (valid) invalidVerificationSuccesses += 1;
        } catch {}
    }

    function enrollUnrelatedRoute(uint8 seed) external {
        uint32 domainId = 3000 + uint32(seed % 16);
        uint16 wormholeChainId = 100 + uint16(seed % 16);
        address remoteRouter = address(uint160(uint256(seed) + 1));

        try
            destinationRouter.enrollRemoteRouter(
                WormholeVaaHookIsm.RemoteRouterEnrollment({
                    domainId: domainId,
                    domainIsm: remoteRouter.addressToBytes32(),
                    wormholeChainId: wormholeChainId,
                    expectedConsistencyLevel: CONSISTENCY
                })
            )
        {} catch {}
    }

    function unenrollUnrelatedRoute(uint8 seed) external {
        uint32 domainId = 3000 + uint32(seed % 16);
        try destinationRouter.unenrollRemoteRouter(domainId) {} catch {}
    }

    function messageCount() external view returns (uint256) {
        return dispatchedMessages.length;
    }

    function messageId(uint256 index) external view returns (bytes32) {
        return dispatchedMessages[index].id();
    }

    function _metadata(
        bytes memory message,
        bytes32 emitterAddress,
        uint64 sequence
    ) private view returns (bytes memory) {
        bytes memory payload = WormholeMessage.encode(
            ORIGIN,
            DESTINATION,
            address(destinationRouter).addressToBytes32(),
            message.id(),
            _nonce(message)
        );
        bytes memory encodedVaa = abi.encode(
            MockWormholeCore.MockVaa({
                emitterChainId: WH_ORIGIN,
                emitterAddress: emitterAddress,
                sequence: sequence,
                nonce: _nonce(message),
                consistencyLevel: CONSISTENCY,
                guardianSetIndex: 0,
                payload: payload
            })
        );
        return abi.encode(encodedVaa);
    }

    function _nonce(bytes memory message) private pure returns (uint32 value) {
        assembly {
            value := shr(224, mload(add(add(message, 32), 1)))
        }
    }
}

contract WormholeHookIsmTest_Invariants is Test {
    using TypeCasts for address;

    uint32 internal constant ORIGIN = 1000;
    uint32 internal constant DESTINATION = 2000;
    uint16 internal constant WH_ORIGIN = 2;
    uint16 internal constant WH_DESTINATION = 30;
    uint8 internal constant CONSISTENCY = 202;
    uint256 internal constant CORE_FEE = 0.001 ether;

    MockWormholeCore internal originCore;
    WormholeVaaHookIsm internal originRouter;
    WormholeVaaHookIsm internal destinationRouter;
    WormholeVaaHandler internal handler;

    function setUp() public {
        TestMailbox originMailbox = new TestMailbox(ORIGIN);
        TestMailbox destinationMailbox = new TestMailbox(DESTINATION);
        originCore = new MockWormholeCore(WH_ORIGIN, CORE_FEE);
        MockWormholeCore destinationCore = new MockWormholeCore(
            WH_DESTINATION,
            CORE_FEE
        );
        TestPostDispatchHook noopHook = new TestPostDispatchHook();
        TestRecipient recipient = new TestRecipient();

        originMailbox.setDefaultHook(address(noopHook));
        originMailbox.setRequiredHook(address(noopHook));
        destinationMailbox.setDefaultHook(address(noopHook));
        destinationMailbox.setRequiredHook(address(noopHook));

        WormholeConsistencyLevelConfig
            memory consistencyConfig = WormholeConsistencyLevelConfig({
                consistencyLevel: CONSISTENCY,
                customConsistencyLevelContract: address(0),
                baseConsistencyLevel: 0,
                additionalBlocks: 0
            });
        string[] memory urls = new string[](1);
        urls[0] = "https://vaa.example/{data}";

        originRouter = new WormholeVaaHookIsm(
            address(originMailbox),
            address(originCore),
            consistencyConfig,
            urls
        );
        destinationRouter = new WormholeVaaHookIsm(
            address(destinationMailbox),
            address(destinationCore),
            consistencyConfig,
            urls
        );

        originRouter.enrollRemoteRouter(
            WormholeVaaHookIsm.RemoteRouterEnrollment({
                domainId: DESTINATION,
                domainIsm: address(destinationRouter).addressToBytes32(),
                wormholeChainId: WH_DESTINATION,
                expectedConsistencyLevel: CONSISTENCY
            })
        );
        destinationRouter.enrollRemoteRouter(
            WormholeVaaHookIsm.RemoteRouterEnrollment({
                domainId: ORIGIN,
                domainIsm: address(originRouter).addressToBytes32(),
                wormholeChainId: WH_ORIGIN,
                expectedConsistencyLevel: CONSISTENCY
            })
        );

        handler = new WormholeVaaHandler(
            originMailbox,
            originCore,
            originRouter,
            destinationRouter,
            address(recipient)
        );
        destinationRouter.transferOwnership(address(handler));
        targetContract(address(handler));
    }

    function invariant_noRepublication() public view {
        assertEq(handler.republishSuccesses(), 0, "message republished");
    }

    function invariant_coreSequenceMatchesPublications() public view {
        assertEq(
            originCore.nextSequence(address(originRouter)),
            handler.publications(),
            "Core sequence diverged"
        );
    }

    function invariant_everyRecordedMessageIsPublished() public view {
        uint256 count = handler.messageCount();
        for (uint256 i; i < count; ++i) {
            assertTrue(
                originRouter.publishedMessages(handler.messageId(i)),
                "recorded message not published"
            );
        }
    }

    function invariant_invalidEmitterNeverVerifies() public view {
        assertEq(
            handler.invalidVerificationSuccesses(),
            0,
            "invalid emitter verified"
        );
    }

    function invariant_validVaaAlwaysVerifies() public view {
        assertEq(handler.validVerificationFailures(), 0, "valid VAA rejected");
    }

    function invariant_reverseIndexMatchesRoutes() public view {
        uint32[] memory domains = destinationRouter.domains();
        for (uint256 i; i < domains.length; ++i) {
            (uint16 wormholeChainId, ) = destinationRouter.remoteRouterConfigs(
                domains[i]
            );
            assertTrue(wormholeChainId != 0, "route missing policy");

            (bool enrolled, uint32 domainId) = destinationRouter
                .wormholeChainEnrollments(wormholeChainId);
            assertTrue(enrolled, "reverse route missing");
            assertEq(domainId, domains[i], "reverse route disagrees");

            for (uint256 j = i + 1; j < domains.length; ++j) {
                (uint16 otherChainId, ) = destinationRouter.remoteRouterConfigs(
                    domains[j]
                );
                assertTrue(
                    wormholeChainId != otherChainId,
                    "Wormhole chain ID aliased"
                );
            }
        }
    }

    function invariant_originRouteStable() public view {
        assertEq(
            destinationRouter.routers(ORIGIN),
            address(originRouter).addressToBytes32()
        );
    }

    function test_handlerHappyPath() public {
        handler.dispatch();
        assertEq(handler.messageCount(), 1);
        handler.verifyValid(0);
        assertEq(handler.validVerificationFailures(), 0);
    }
}
