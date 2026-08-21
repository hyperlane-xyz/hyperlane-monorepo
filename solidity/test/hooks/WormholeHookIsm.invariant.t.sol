// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.19;

import {Test} from "forge-std/Test.sol";

import {WormholeExecutorHookIsm} from "contracts/hooks/wormhole/WormholeExecutorHookIsm.sol";
import {WormholeMessage} from "contracts/libs/WormholeMessage.sol";
import {WormholeVaaHookIsm} from "contracts/hooks/wormhole/WormholeVaaHookIsm.sol";
import {WormholeConsistencyLevelConfig} from "contracts/hooks/wormhole/libs/CustomConsistencyLevel.sol";
import {IPostDispatchHook} from "contracts/interfaces/hooks/IPostDispatchHook.sol";
import {IInterchainSecurityModule} from "contracts/interfaces/IInterchainSecurityModule.sol";
import {RemoteRouterEnrollment} from "contracts/interfaces/wormhole/IWormholeHookIsm.sol";
import {Message} from "contracts/libs/Message.sol";
import {TypeCasts} from "contracts/libs/TypeCasts.sol";
import {MockExecutorQuoterRouter} from "contracts/mock/MockExecutorQuoterRouter.sol";
import {MockWormholeCore} from "contracts/mock/MockWormholeCore.sol";
import {TestMailbox} from "contracts/test/TestMailbox.sol";
import {TestPostDispatchHook} from "contracts/test/TestPostDispatchHook.sol";
import {TestRecipient} from "contracts/test/TestRecipient.sol";

/**
 * @dev Drives the Executor router with valid and corrupted VAAs, republication
 * attempts, and unrelated route churn. Every action swallows reverts so the
 * fuzzer keeps exploring; the invariants live on the test contract.
 */
contract WormholeExecutorHandler is Test {
    using Message for bytes;
    using TypeCasts for address;

    uint32 internal constant ORIGIN = 1000;
    uint32 internal constant DESTINATION = 2000;
    uint16 internal constant WH_ORIGIN = 2;
    uint16 internal constant WH_DESTINATION = 30;
    uint8 internal constant CONSISTENCY = 202;
    uint256 internal constant CORE_FEE = 0.001 ether;
    uint256 internal constant EXECUTOR_FEE = 0.002 ether;
    uint128 internal constant CALLBACK_GAS = 300_000;

    TestMailbox internal originMailbox;
    MockWormholeCore internal originCore;
    WormholeExecutorHookIsm internal originRouter;
    WormholeExecutorHookIsm internal destinationRouter;
    address internal recipient;
    address internal quoter;

    bytes32[] public messageIds;
    mapping(bytes32 messageId => uint32 nonce) public nonceOf;
    mapping(bytes32 messageId => uint64 authorization)
        public firstAuthorization;
    bytes32[] public authorizedIds;
    bytes32[] public crossOriginIds;
    mapping(bytes32 messageId => uint32 claimedOrigin) public claimedOriginOf;

    uint256 public republishSuccesses;
    uint64 public publications;
    bytes internal latestMessage;

    constructor(
        TestMailbox originMailbox_,
        MockWormholeCore originCore_,
        WormholeExecutorHookIsm originRouter_,
        WormholeExecutorHookIsm destinationRouter_,
        address recipient_,
        address quoter_
    ) {
        originMailbox = originMailbox_;
        originCore = originCore_;
        originRouter = originRouter_;
        destinationRouter = destinationRouter_;
        recipient = recipient_;
        quoter = quoter_;
    }

    receive() external payable {}

    // ============ Actions ============

    function dispatch() external {
        vm.deal(address(this), 10 ether);
        bytes memory message = originMailbox.buildOutboundMessage(
            DESTINATION,
            recipient.addressToBytes32(),
            "invariant"
        );
        try
            originMailbox.dispatch{value: CORE_FEE + EXECUTOR_FEE}(
                DESTINATION,
                recipient.addressToBytes32(),
                "invariant",
                "",
                IPostDispatchHook(address(originRouter))
            )
        {
            bytes32 id = message.id();
            messageIds.push(id);
            nonceOf[id] = _nonce(message);
            latestMessage = message;
            publications += 1;
        } catch {}
    }

    /// @dev Republishing an already published message must always fail.
    function republishLatest() external {
        if (latestMessage.length == 0) return;
        vm.deal(address(this), 10 ether);
        try
            IPostDispatchHook(address(originRouter)).postDispatch{
                value: CORE_FEE + EXECUTOR_FEE
            }("", latestMessage)
        {
            republishSuccesses += 1;
        } catch {}
    }

    function authorizeValid(uint256 seed) external {
        if (messageIds.length == 0) return;
        uint256 index = seed % messageIds.length;
        bytes32 id = messageIds[index];
        bytes memory vaa = _vaa(
            WH_ORIGIN,
            address(originRouter).addressToBytes32(),
            uint64(index),
            nonceOf[id],
            CONSISTENCY,
            0,
            WormholeMessage.encode(
                ORIGIN,
                DESTINATION,
                address(destinationRouter).addressToBytes32(),
                id,
                nonceOf[id]
            )
        );
        _tryAuthorize(vaa, id);
    }

    /// @dev Fuzzes the signed VAA header while the payload stays correct.
    function authorizeWrongEmitter(
        uint256 seed,
        uint16 emitterChainId,
        bytes32 emitterAddress,
        uint8 consistencyLevel
    ) external {
        if (messageIds.length == 0) return;
        bytes32 id = messageIds[seed % messageIds.length];
        _tryAuthorize(
            _vaa(
                emitterChainId,
                emitterAddress,
                uint64(seed % messageIds.length),
                nonceOf[id],
                consistencyLevel,
                0,
                _payload(
                    ORIGIN,
                    DESTINATION,
                    address(destinationRouter).addressToBytes32(),
                    id,
                    nonceOf[id]
                )
            ),
            id
        );
    }

    /// @dev Fuzzes the routing fields of the signed payload.
    function authorizeWrongPayload(
        uint256 seed,
        uint32 originDomain,
        uint32 destinationDomain,
        uint32 nonce
    ) external {
        if (messageIds.length == 0) return;
        bytes32 id = messageIds[seed % messageIds.length];
        _tryAuthorize(
            _vaa(
                WH_ORIGIN,
                address(originRouter).addressToBytes32(),
                uint64(seed % messageIds.length),
                nonce,
                CONSISTENCY,
                0,
                _payload(
                    originDomain,
                    destinationDomain,
                    address(destinationRouter).addressToBytes32(),
                    id,
                    nonce
                )
            ),
            id
        );
    }

    /// @dev Fuzzes the destination-router binding that stops multicast replay.
    function authorizeWrongDestinationRouter(
        uint256 seed,
        bytes32 destinationRouterField
    ) external {
        if (messageIds.length == 0) return;
        bytes32 id = messageIds[seed % messageIds.length];
        _tryAuthorize(
            _vaa(
                WH_ORIGIN,
                address(originRouter).addressToBytes32(),
                uint64(seed % messageIds.length),
                nonceOf[id],
                CONSISTENCY,
                0,
                _payload(
                    ORIGIN,
                    DESTINATION,
                    destinationRouterField,
                    id,
                    nonceOf[id]
                )
            ),
            id
        );
    }

    /// @dev Authenticates a VAA from ORIGIN whose message ID belongs to a
    /// Hyperlane message claiming another origin. The callback may authorize
    /// that ID only inside ORIGIN's namespace.
    function authorizeMessageClaimingOtherOrigin(
        uint256 seed,
        uint32 claimedOrigin
    ) external {
        claimedOrigin = uint32(bound(claimedOrigin, 3000, 9000));
        uint32 nonce = uint32(seed);
        bytes32 id = keccak256(
            abi.encodePacked(
                originMailbox.VERSION(),
                nonce,
                claimedOrigin,
                address(this).addressToBytes32(),
                DESTINATION,
                recipient.addressToBytes32(),
                bytes("invariant")
            )
        );
        uint64 beforeAuthorization = destinationRouter.authorizations(
            ORIGIN,
            id
        );
        _tryAuthorize(
            _vaa(
                WH_ORIGIN,
                address(originRouter).addressToBytes32(),
                uint64(seed),
                nonce,
                CONSISTENCY,
                0,
                _payload(
                    ORIGIN,
                    DESTINATION,
                    address(destinationRouter).addressToBytes32(),
                    id,
                    nonce
                )
            ),
            id
        );
        if (
            beforeAuthorization == 0 &&
            destinationRouter.authorizations(ORIGIN, id) != 0
        ) {
            claimedOriginOf[id] = claimedOrigin;
            crossOriginIds.push(id);
        }
    }

    /// @dev Churns unrelated routes; never touches the enrolled ORIGIN entry.
    function enrollOther(uint32 domain, uint16 wormholeChainId) external {
        domain = uint32(bound(domain, 3000, 9000));
        wormholeChainId = uint16(bound(wormholeChainId, 100, 500));
        try
            destinationRouter.enrollRemoteRouter(
                WormholeExecutorHookIsm.ExecutorRemoteRouterEnrollment({
                    remoteRouter: RemoteRouterEnrollment({
                        domain: domain,
                        router: address(uint160(uint256(domain) + 1))
                            .addressToBytes32(),
                        wormholeChainId: wormholeChainId,
                        expectedConsistencyLevel: CONSISTENCY
                    }),
                    quoter: quoter,
                    callbackGasLimit: CALLBACK_GAS
                })
            )
        {} catch {}
    }

    function unenrollOther(uint32 domain) external {
        domain = uint32(bound(domain, 3000, 9000));
        try destinationRouter.unenrollRemoteRouter(domain) {} catch {}
    }

    // ============ Views for invariants ============

    function messageIdCount() external view returns (uint256) {
        return messageIds.length;
    }

    function authorizedIdCount() external view returns (uint256) {
        return authorizedIds.length;
    }

    function crossOriginIdCount() external view returns (uint256) {
        return crossOriginIds.length;
    }

    // ============ Internals ============

    function _tryAuthorize(bytes memory vaa, bytes32 id) internal {
        try destinationRouter.executeVAAv1(vaa) {
            uint64 stored = destinationRouter.authorizations(ORIGIN, id);
            if (stored != 0 && firstAuthorization[id] == 0) {
                firstAuthorization[id] = stored;
                authorizedIds.push(id);
            }
        } catch {}
    }

    function _payload(
        uint32 originDomain,
        uint32 destinationDomain,
        bytes32 destinationRouterField,
        bytes32 messageId,
        uint32 nonce
    ) internal pure returns (bytes memory) {
        return
            WormholeMessage.encode(
                originDomain,
                destinationDomain,
                destinationRouterField,
                messageId,
                nonce
            );
    }

    function _vaa(
        uint16 emitterChainId,
        bytes32 emitterAddress,
        uint64 sequence,
        uint32 nonce,
        uint8 consistencyLevel,
        uint32 guardianSetIndex,
        bytes memory payload
    ) internal pure returns (bytes memory) {
        return
            abi.encode(
                MockWormholeCore.MockVaa({
                    emitterChainId: emitterChainId,
                    emitterAddress: emitterAddress,
                    sequence: sequence,
                    nonce: nonce,
                    consistencyLevel: consistencyLevel,
                    guardianSetIndex: guardianSetIndex,
                    payload: payload
                })
            );
    }

    function _nonce(bytes memory m) internal pure returns (uint32 value) {
        assembly {
            value := shr(224, mload(add(add(m, 32), 1)))
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
    uint256 internal constant EXECUTOR_FEE = 0.002 ether;
    uint128 internal constant CALLBACK_GAS = 300_000;

    WormholeExecutorHookIsm internal originRouter;
    WormholeExecutorHookIsm internal destinationRouter;
    WormholeExecutorHandler internal handler;

    function setUp() public {
        TestMailbox originMailbox = new TestMailbox(ORIGIN);
        TestMailbox destinationMailbox = new TestMailbox(DESTINATION);
        MockWormholeCore originCore = new MockWormholeCore(WH_ORIGIN, CORE_FEE);
        MockWormholeCore destinationCore = new MockWormholeCore(
            WH_DESTINATION,
            CORE_FEE
        );
        MockExecutorQuoterRouter quoterRouter = new MockExecutorQuoterRouter(
            EXECUTOR_FEE
        );
        TestPostDispatchHook noopHook = new TestPostDispatchHook();
        TestRecipient recipient = new TestRecipient();
        address quoter = makeAddr("quoter");

        originMailbox.setDefaultHook(address(noopHook));
        originMailbox.setRequiredHook(address(noopHook));
        destinationMailbox.setDefaultHook(address(noopHook));
        destinationMailbox.setRequiredHook(address(noopHook));
        destinationMailbox.setDefaultIsm(address(noopHook));

        WormholeConsistencyLevelConfig
            memory consistencyLevelConfig = WormholeConsistencyLevelConfig({
                consistencyLevel: CONSISTENCY,
                customConsistencyLevel: address(0),
                baseConsistencyLevel: 0,
                additionalBlocks: 0
            });

        originRouter = new WormholeExecutorHookIsm(
            address(originMailbox),
            address(originCore),
            consistencyLevelConfig,
            address(quoterRouter)
        );
        destinationRouter = new WormholeExecutorHookIsm(
            address(destinationMailbox),
            address(destinationCore),
            consistencyLevelConfig,
            address(quoterRouter)
        );

        originRouter.enrollRemoteRouter(
            WormholeExecutorHookIsm.ExecutorRemoteRouterEnrollment({
                remoteRouter: RemoteRouterEnrollment({
                    domain: DESTINATION,
                    router: address(destinationRouter).addressToBytes32(),
                    wormholeChainId: WH_DESTINATION,
                    expectedConsistencyLevel: CONSISTENCY
                }),
                quoter: quoter,
                callbackGasLimit: CALLBACK_GAS
            })
        );
        destinationRouter.enrollRemoteRouter(
            WormholeExecutorHookIsm.ExecutorRemoteRouterEnrollment({
                remoteRouter: RemoteRouterEnrollment({
                    domain: ORIGIN,
                    router: address(originRouter).addressToBytes32(),
                    wormholeChainId: WH_ORIGIN,
                    expectedConsistencyLevel: CONSISTENCY
                }),
                quoter: quoter,
                callbackGasLimit: CALLBACK_GAS
            })
        );

        handler = new WormholeExecutorHandler(
            originMailbox,
            originCore,
            originRouter,
            destinationRouter,
            address(recipient),
            quoter
        );
        destinationRouter.transferOwnership(address(handler));

        targetContract(address(handler));
    }

    /// @dev An authorization is written once and never rewritten.
    function invariant_authorizationNeverChanges() public view {
        uint256 count = handler.authorizedIdCount();
        for (uint256 i; i < count; ++i) {
            bytes32 id = handler.authorizedIds(i);
            assertEq(
                destinationRouter.authorizations(ORIGIN, id),
                handler.firstAuthorization(id),
                "authorization mutated"
            );
        }
    }

    /// @dev A nonzero authorization always encodes the dispatched Hyperlane
    /// nonce plus one, so only a VAA carrying that exact message can set it.
    function invariant_authorizationEncodesDispatchedNonce() public view {
        uint256 count = handler.messageIdCount();
        for (uint256 i; i < count; ++i) {
            bytes32 id = handler.messageIds(i);
            uint64 stored = destinationRouter.authorizations(ORIGIN, id);
            if (stored == 0) continue;
            assertEq(
                stored,
                uint64(handler.nonceOf(id)) + 1,
                "authorization does not match dispatched nonce"
            );
        }
    }

    /// @dev A VAA authenticated as ORIGIN cannot authorize its message ID under
    /// the origin domain claimed by the corresponding Hyperlane message.
    function invariant_authorizationIsNamespacedByOrigin() public view {
        uint256 count = handler.crossOriginIdCount();
        for (uint256 i; i < count; ++i) {
            bytes32 id = handler.crossOriginIds(i);
            uint32 claimedOrigin = handler.claimedOriginOf(id);
            assertTrue(claimedOrigin != ORIGIN, "cross-origin fixture invalid");
            assertEq(
                destinationRouter.authorizations(claimedOrigin, id),
                0,
                "authorization escaped its authenticated origin"
            );
        }
    }

    /// @dev One Hyperlane message can be published through Core at most once.
    function invariant_noRepublication() public view {
        assertEq(handler.republishSuccesses(), 0, "message republished");
    }

    /// @dev No Wormhole chain ID is ever claimed by two live Hyperlane domains,
    /// and the reverse index always agrees with the forward config.
    function invariant_oneDomainPerWormholeChainId() public view {
        uint32[] memory domains = destinationRouter.domains();
        for (uint256 i; i < domains.length; ++i) {
            (uint16 wormholeChainId, ) = destinationRouter.remoteRouterConfigs(
                domains[i]
            );
            assertTrue(wormholeChainId != 0, "enrolled route without policy");
            assertEq(
                destinationRouter.hyperlaneDomainPlusOne(wormholeChainId),
                uint64(domains[i]) + 1,
                "reverse index disagrees"
            );
            for (uint256 j = i + 1; j < domains.length; ++j) {
                (uint16 other, ) = destinationRouter.remoteRouterConfigs(
                    domains[j]
                );
                assertTrue(wormholeChainId != other, "aliased Wormhole ID");
            }
        }
    }

    /// @dev Guards the invariants above from passing vacuously: the handler's
    /// happy path must really dispatch and authorize.
    function test_handlerHappyPathAuthorizes() public {
        handler.dispatch();
        assertEq(handler.messageIdCount(), 1);

        handler.authorizeValid(0);
        assertEq(handler.authorizedIdCount(), 1);

        bytes32 id = handler.messageIds(0);
        assertEq(
            destinationRouter.authorizations(ORIGIN, id),
            uint64(handler.nonceOf(id)) + 1
        );
    }

    /// @dev The enrolled origin route is never disturbed by unrelated churn.
    function invariant_originRouteStable() public view {
        assertEq(
            destinationRouter.routers(ORIGIN),
            address(originRouter).addressToBytes32()
        );
    }
}
