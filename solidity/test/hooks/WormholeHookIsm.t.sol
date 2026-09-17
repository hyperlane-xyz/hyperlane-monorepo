// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.19;

import {Test} from "forge-std/Test.sol";
import {CoreBridgeVM, ICoreBridge} from "wormhole-sdk/interfaces/ICoreBridge.sol";
import {CONSISTENCY_LEVEL_FINALIZED} from "wormhole-sdk/constants/ConsistencyLevel.sol";

import {WormholeVaaHookIsm} from "contracts/hooks/wormhole/WormholeVaaHookIsm.sol";
import {WormholeMessage} from "contracts/libs/WormholeMessage.sol";
import {ReverseMappingLib} from "contracts/libs/ReverseMapping.sol";
import {WormholeConsistencyLevelConfig} from "contracts/hooks/wormhole/libs/CustomConsistencyLevel.sol";
import {StandardHookMetadata} from "contracts/hooks/libs/StandardHookMetadata.sol";
import {IInterchainSecurityModule} from "contracts/interfaces/IInterchainSecurityModule.sol";
import {IPostDispatchHook} from "contracts/interfaces/hooks/IPostDispatchHook.sol";
import {ICcipReadIsm} from "contracts/interfaces/isms/ICcipReadIsm.sol";
import {IWormholeVaaService} from "contracts/interfaces/wormhole/IWormholeVaaService.sol";
import {Message} from "contracts/libs/Message.sol";
import {TypeCasts} from "contracts/libs/TypeCasts.sol";
import {MockCustomConsistencyLevel} from "contracts/mock/MockCustomConsistencyLevel.sol";
import {MockWormholeCore} from "contracts/mock/MockWormholeCore.sol";
import {TestMailbox} from "contracts/test/TestMailbox.sol";
import {TestPostDispatchHook} from "contracts/test/TestPostDispatchHook.sol";
import {TestRecipient} from "contracts/test/TestRecipient.sol";

/// @dev Two domains, each with a Mailbox, Wormhole Core, and combined hook/ISM.
contract WormholeHookIsmTest is Test {
    using Message for bytes;
    using TypeCasts for address;

    uint32 internal constant ORIGIN = 1000;
    uint32 internal constant DESTINATION = 2000;
    uint16 internal constant WH_ORIGIN = 2;
    uint16 internal constant WH_DESTINATION = 30;
    uint8 internal constant CONSISTENCY = 202;
    uint256 internal constant CORE_FEE = 0.001 ether;

    TestMailbox internal originMailbox;
    TestMailbox internal destinationMailbox;
    MockWormholeCore internal originCore;
    MockWormholeCore internal destinationCore;
    TestPostDispatchHook internal noopHook;
    TestRecipient internal recipient;

    WormholeVaaHookIsm internal originRouter;
    WormholeVaaHookIsm internal destinationRouter;

    address internal owner = address(this);
    address internal alice = makeAddr("alice");

    /// @dev Successful publications so far, mirroring the Core sequence.
    uint64 internal dispatchCount;

    function setUp() public virtual {
        originMailbox = new TestMailbox(ORIGIN);
        destinationMailbox = new TestMailbox(DESTINATION);
        originCore = new MockWormholeCore(WH_ORIGIN, CORE_FEE);
        destinationCore = new MockWormholeCore(WH_DESTINATION, CORE_FEE);
        noopHook = new TestPostDispatchHook();
        recipient = new TestRecipient();

        originMailbox.setDefaultHook(address(noopHook));
        originMailbox.setRequiredHook(address(noopHook));
        destinationMailbox.setDefaultHook(address(noopHook));
        destinationMailbox.setRequiredHook(address(noopHook));
        destinationMailbox.setDefaultIsm(address(noopHook));

        originRouter = _deployRouter(
            address(originMailbox),
            address(originCore)
        );
        destinationRouter = _deployRouter(
            address(destinationMailbox),
            address(destinationCore)
        );

        _enroll(
            originRouter,
            DESTINATION,
            address(destinationRouter),
            WH_DESTINATION
        );
        _enroll(destinationRouter, ORIGIN, address(originRouter), WH_ORIGIN);

        recipient.setInterchainSecurityModule(address(destinationRouter));
        vm.deal(address(this), 100 ether);
        vm.deal(alice, 100 ether);
    }

    // ============ Helpers ============

    function _consistencyLevelConfig()
        internal
        pure
        returns (WormholeConsistencyLevelConfig memory)
    {
        return
            WormholeConsistencyLevelConfig({
                consistencyLevel: CONSISTENCY,
                customConsistencyLevelContract: address(0),
                baseConsistencyLevel: 0,
                additionalBlocks: 0
            });
    }

    // ============ Memory-message field helpers ============
    // `Message` parses `bytes calldata`; tests hold messages in memory. These
    // stay `pure` so building a fixture never consumes a `vm.expectRevert`.

    function _readUint32(
        bytes memory m,
        uint256 offset
    ) private pure returns (uint32 value) {
        assembly {
            value := shr(224, mload(add(add(m, 32), offset)))
        }
    }

    function _nonce(bytes memory m) internal pure returns (uint32) {
        return _readUint32(m, 1);
    }

    function _origin(bytes memory m) internal pure returns (uint32) {
        return _readUint32(m, 5);
    }

    function _destination(bytes memory m) internal pure returns (uint32) {
        return _readUint32(m, 41);
    }

    function _body() internal pure returns (bytes memory) {
        return bytes("hyperlane over wormhole");
    }

    /// @dev Builds the exact message the next `dispatch` from this contract will
    /// produce, then dispatches it through `originRouter`.
    function _dispatch(
        uint256 value
    ) internal returns (bytes memory message, bytes32 messageId) {
        message = originMailbox.buildOutboundMessage(
            DESTINATION,
            address(recipient).addressToBytes32(),
            _body()
        );
        messageId = message.id();
        dispatchCount += 1;
        originMailbox.dispatch{value: value}(
            DESTINATION,
            address(recipient).addressToBytes32(),
            _body(),
            "",
            IPostDispatchHook(address(originRouter))
        );
    }

    function _dispatch()
        internal
        returns (bytes memory message, bytes32 messageId)
    {
        return _dispatch(CORE_FEE);
    }

    /// @dev Dispatch with no preceding external call, so `vm.expectRevert`
    /// binds to the dispatch itself.
    function _dispatchOnly(uint256 value) internal {
        originMailbox.dispatch{value: value}(
            DESTINATION,
            address(recipient).addressToBytes32(),
            _body(),
            "",
            IPostDispatchHook(address(originRouter))
        );
    }

    function _dispatchOnly() internal {
        _dispatchOnly(CORE_FEE);
    }

    /// @dev A VAA the destination router should accept for `message`.
    function _validVaa(
        bytes memory message,
        uint64 sequence
    ) internal view returns (bytes memory) {
        return
            _vaa(
                WH_ORIGIN,
                address(originRouter).addressToBytes32(),
                sequence,
                _nonce(message),
                CONSISTENCY,
                0,
                WormholeMessage.encode(
                    _origin(message),
                    _destination(message),
                    address(destinationRouter).addressToBytes32(),
                    message.id(),
                    _nonce(message)
                )
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

    function _remoteRouterConfig(
        uint32 domainId,
        address remote,
        uint16 wormholeChainId
    ) internal pure returns (WormholeVaaHookIsm.RemoteRouterConfig memory) {
        return
            WormholeVaaHookIsm.RemoteRouterConfig({
                domainId: domainId,
                domainIsm: TypeCasts.addressToBytes32(remote),
                wormholeChainId: wormholeChainId,
                expectedConsistencyLevel: CONSISTENCY
            });
    }
    // ============ Construction ============

    function test_constructor_readsWormholeIdentity() public view {
        assertEq(
            address(originRouter.wormholeCoreBridge()),
            address(originCore)
        );
        assertEq(originRouter.wormholeChainId(), WH_ORIGIN);
        assertEq(originRouter.consistencyLevel(), CONSISTENCY);
        assertEq(originRouter.localDomain(), ORIGIN);
    }

    function test_constructor_rejectsNonContractCore() public {
        vm.expectRevert(WormholeVaaHookIsm.InvalidWormholeCore.selector);
        _deployRouter(address(originMailbox), makeAddr("notACore"));
    }

    function test_constructor_rejectsZeroWormholeChainId() public {
        MockWormholeCore zeroCore = new MockWormholeCore(0, CORE_FEE);
        vm.expectRevert(WormholeVaaHookIsm.InvalidWormholeChainId.selector);
        _deployRouter(address(originMailbox), address(zeroCore));
    }

    function test_constructor_rejectsWrongEvmChainId() public {
        MockWormholeCore wrongChainCore = new MockWormholeCore(
            WH_ORIGIN,
            CORE_FEE
        );
        wrongChainCore.setEvmChainId(block.chainid + 1);
        vm.expectRevert(WormholeVaaHookIsm.InvalidWormholeEvmChainId.selector);
        _deployRouter(address(originMailbox), address(wrongChainCore));
    }

    function test_hookType_isWormhole() public view {
        assertEq(
            IPostDispatchHook(address(originRouter)).hookType(),
            uint8(IPostDispatchHook.HookTypes.WORMHOLE)
        );
    }

    function test_mockCore_parsesProductionWireLayout() public view {
        bytes memory payload = bytes("wire payload");
        bytes memory encodedVaa = abi.encodePacked(
            uint8(1),
            uint32(0),
            uint8(0),
            uint32(1_700_000_000),
            uint32(7),
            WH_ORIGIN,
            address(originRouter).addressToBytes32(),
            uint64(11),
            CONSISTENCY,
            payload
        );

        (CoreBridgeVM memory parsed, bool valid, ) = destinationCore
            .parseAndVerifyVM(encodedVaa);
        assertTrue(valid);
        assertEq(parsed.nonce, 7);
        assertEq(parsed.emitterChainId, WH_ORIGIN);
        assertEq(
            parsed.emitterAddress,
            address(originRouter).addressToBytes32()
        );
        assertEq(parsed.sequence, 11);
        assertEq(parsed.consistencyLevel, CONSISTENCY);
        assertEq(parsed.payload, payload);
    }

    // ============ Enrollment ============

    function test_enroll_storesRouterAndPolicy() public view {
        assertEq(
            originRouter.routers(DESTINATION),
            address(destinationRouter).addressToBytes32()
        );
        (uint16 whId, uint8 consistency) = originRouter.remoteRouterConfigs(
            DESTINATION
        );
        assertEq(whId, WH_DESTINATION);
        assertEq(consistency, CONSISTENCY);
        (bool enrolled, uint32 domainId) = originRouter.remoteWormholeChains(
            WH_DESTINATION
        );
        assertTrue(enrolled);
        assertEq(domainId, DESTINATION);
    }

    function test_enroll_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert("Ownable: caller is not the owner");
        _enroll(originRouter, 3000, makeAddr("remote"), 42);
    }

    function test_enroll_rejectsLocalDomain() public {
        vm.expectRevert(WormholeVaaHookIsm.InvalidRemoteDomain.selector);
        _enroll(originRouter, ORIGIN, makeAddr("remote"), 42);
    }

    function test_enroll_rejectsZeroRouter() public {
        vm.expectRevert(WormholeVaaHookIsm.InvalidDomainIsm.selector);
        _enroll(originRouter, 3000, address(0), 42);
    }

    function test_enroll_preservesFullWidthRouterInPublishedPayload() public {
        bytes32 remoteRouter = bytes32((uint256(1) << 255) | uint256(0xBEEF));
        WormholeVaaHookIsm.RemoteRouterConfig
            memory config = _remoteRouterConfig(
                DESTINATION,
                address(destinationRouter),
                WH_DESTINATION
            );
        config.domainIsm = remoteRouter;
        originRouter.enrollRemoteRouter(config);

        assertEq(originRouter.routers(DESTINATION), remoteRouter);

        bytes memory message = originMailbox.buildOutboundMessage(
            DESTINATION,
            address(recipient).addressToBytes32(),
            _body()
        );
        vm.expectEmit(true, false, false, true, address(originCore));
        emit ICoreBridge.LogMessagePublished(
            address(originRouter),
            0,
            _nonce(message),
            WormholeMessage.encode(
                ORIGIN,
                DESTINATION,
                remoteRouter,
                message.id(),
                _nonce(message)
            ),
            CONSISTENCY
        );
        _dispatch();
    }

    function test_verify_acceptsFullWidthEmitter() public {
        bytes32 remoteEmitter = bytes32((uint256(1) << 255) | uint256(0xBEEF));
        WormholeVaaHookIsm.RemoteRouterConfig
            memory config = _remoteRouterConfig(
                ORIGIN,
                address(originRouter),
                WH_ORIGIN
            );
        config.domainIsm = remoteEmitter;
        destinationRouter.enrollRemoteRouter(config);

        (bytes memory message, ) = _dispatch();
        bytes memory encodedVaa = _vaa(
            WH_ORIGIN,
            remoteEmitter,
            0,
            _nonce(message),
            CONSISTENCY,
            0,
            _payloadFor(message)
        );
        assertTrue(_verify(message, _wrapVaa(encodedVaa)));

        // The low 160 bits alone must not authenticate the enrolled emitter.
        bytes memory truncatedEmitterVaa = _vaa(
            WH_ORIGIN,
            bytes32(uint256(0xBEEF)),
            0,
            _nonce(message),
            CONSISTENCY,
            0,
            _payloadFor(message)
        );
        vm.expectRevert(WormholeVaaHookIsm.WrongEmitterAddress.selector);
        _verify(message, _wrapVaa(truncatedEmitterVaa));
    }

    function test_enroll_rejectsZeroWormholeChainId() public {
        vm.expectRevert(WormholeVaaHookIsm.InvalidWormholeChainId.selector);
        _enroll(originRouter, 3000, makeAddr("remote"), 0);
    }

    function test_enroll_rejectsLocalWormholeChainId() public {
        vm.expectRevert(
            WormholeVaaHookIsm.InvalidRemoteWormholeChainId.selector
        );
        _enroll(originRouter, 3000, makeAddr("remote"), WH_ORIGIN);
    }

    function test_enroll_rejectsWormholeChainIdAlias() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                ReverseMappingLib.ReverseKeyAssignedToAnotherKey.selector,
                WH_DESTINATION,
                DESTINATION
            )
        );
        _enroll(originRouter, 3000, makeAddr("remote"), WH_DESTINATION);
    }

    function test_enroll_domainZeroDoesNotConflictWithUnenrolledSentinel()
        public
    {
        uint16 wormholeChainId = 42;
        _enroll(originRouter, 0, makeAddr("domainZeroRouter"), wormholeChainId);

        (bool enrolled, uint32 domainId) = originRouter.remoteWormholeChains(
            wormholeChainId
        );
        assertTrue(enrolled);
        assertEq(domainId, 0);

        vm.expectRevert(
            abi.encodeWithSelector(
                ReverseMappingLib.ReverseKeyAssignedToAnotherKey.selector,
                wormholeChainId,
                0
            )
        );
        _enroll(originRouter, 3000, makeAddr("otherRouter"), wormholeChainId);
    }

    function test_enroll_reassignsWormholeChainIdInPlace() public {
        address replacement = makeAddr("replacement");
        uint16 newChainId = 77;
        _enroll(originRouter, DESTINATION, replacement, newChainId);

        assertEq(
            originRouter.routers(DESTINATION),
            replacement.addressToBytes32()
        );
        (uint16 chainId, uint8 level) = originRouter.remoteRouterConfigs(
            DESTINATION
        );
        assertEq(chainId, newChainId);
        assertEq(level, CONSISTENCY);

        (bool oldAssigned, ) = originRouter.remoteWormholeChains(
            WH_DESTINATION
        );
        assertFalse(oldAssigned);
        (bool newAssigned, uint32 domainId) = originRouter.remoteWormholeChains(
            newChainId
        );
        assertTrue(newAssigned);
        assertEq(domainId, DESTINATION);

        _enroll(originRouter, 3000, makeAddr("otherRemote"), WH_DESTINATION);
    }

    function test_enroll_rejectsReassignmentToOccupiedChainId() public {
        uint32 otherDomain = 3000;
        uint16 occupiedChainId = 77;
        _enroll(
            originRouter,
            otherDomain,
            makeAddr("otherRemote"),
            occupiedChainId
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                ReverseMappingLib.ReverseKeyAssignedToAnotherKey.selector,
                occupiedChainId,
                otherDomain
            )
        );
        _enroll(
            originRouter,
            DESTINATION,
            makeAddr("replacement"),
            occupiedChainId
        );

        (uint16 chainId, ) = originRouter.remoteRouterConfigs(DESTINATION);
        assertEq(chainId, WH_DESTINATION);
        assertEq(
            originRouter.routers(DESTINATION),
            address(destinationRouter).addressToBytes32()
        );
    }

    function test_batchEnrollment_rollsBackOnLaterChainIdCollision() public {
        uint32 newDomain = 3000;
        uint16 newChainId = 77;
        WormholeVaaHookIsm.RemoteRouterConfig[]
            memory configs = new WormholeVaaHookIsm.RemoteRouterConfig[](2);
        configs[0] = _remoteRouterConfig(
            newDomain,
            makeAddr("newRemote"),
            newChainId
        );
        configs[1] = _remoteRouterConfig(
            4000,
            makeAddr("conflictingRemote"),
            WH_DESTINATION
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                ReverseMappingLib.ReverseKeyAssignedToAnotherKey.selector,
                WH_DESTINATION,
                DESTINATION
            )
        );
        originRouter.enrollRemoteRouters(configs);

        assertEq(originRouter.routers(newDomain), bytes32(0));
        (uint16 chainId, uint8 consistencyLevel) = originRouter
            .remoteRouterConfigs(newDomain);
        assertEq(chainId, 0);
        assertEq(consistencyLevel, 0);

        (bool assigned, ) = originRouter.remoteWormholeChains(newChainId);
        assertFalse(assigned);
        assertEq(originRouter.domains().length, 1);
    }

    function test_reassignment_rejectsVaaFromOldWormholeChain() public {
        (bytes memory message, ) = _dispatch();
        bytes memory metadata = _ismMetadata(message, 0);

        _enroll(destinationRouter, ORIGIN, address(originRouter), 77);

        vm.expectRevert(WormholeVaaHookIsm.WrongEmitterChainId.selector);
        _verify(message, metadata);
    }

    function test_reassignment_acceptsVaaFromNewWormholeChain() public {
        (bytes memory message, ) = _dispatch();
        uint16 newChainId = 77;
        _enroll(destinationRouter, ORIGIN, address(originRouter), newChainId);

        bytes memory encodedVaa = _vaa(
            newChainId,
            address(originRouter).addressToBytes32(),
            0,
            _nonce(message),
            CONSISTENCY,
            0,
            _payloadFor(message)
        );

        assertTrue(_verify(message, _wrapVaa(encodedVaa)));
    }

    function test_enroll_updatesExpectedConsistencyLevel() public {
        (bytes memory message, ) = _dispatch();
        bytes memory oldMetadata = _ismMetadata(message, 0);

        uint8 updatedConsistencyLevel = CONSISTENCY - 1;
        WormholeVaaHookIsm.RemoteRouterConfig
            memory config = _remoteRouterConfig(
                ORIGIN,
                address(originRouter),
                WH_ORIGIN
            );
        config.expectedConsistencyLevel = updatedConsistencyLevel;
        destinationRouter.enrollRemoteRouter(config);

        vm.expectRevert(WormholeVaaHookIsm.WrongConsistencyLevel.selector);
        _verify(message, oldMetadata);

        bytes memory updatedVaa = _vaa(
            WH_ORIGIN,
            address(originRouter).addressToBytes32(),
            0,
            _nonce(message),
            updatedConsistencyLevel,
            0,
            _payloadFor(message)
        );
        assertTrue(_verify(message, _wrapVaa(updatedVaa)));
    }

    function test_enroll_replacesRouterImmediately() public {
        address replacement = makeAddr("replacement");
        _enroll(originRouter, DESTINATION, replacement, WH_DESTINATION);
        assertEq(
            originRouter.routers(DESTINATION),
            replacement.addressToBytes32()
        );
    }

    function test_replacement_rejectsOldRouterVaa() public {
        (bytes memory message, ) = _dispatch();
        bytes memory metadata = _ismMetadata(message, 0);

        // Replace the origin router that the destination trusts.
        _enroll(destinationRouter, ORIGIN, makeAddr("newOrigin"), WH_ORIGIN);

        vm.expectRevert(WormholeVaaHookIsm.WrongEmitterAddress.selector);
        _verify(message, metadata);
    }

    function test_baseTwoArgEnrollment_reverts() public {
        vm.expectRevert(
            WormholeVaaHookIsm.CompleteWormholeEnrollmentRequired.selector
        );
        originRouter.enrollRemoteRouter(
            3000,
            makeAddr("remote").addressToBytes32()
        );
    }

    function test_baseBatchEnrollment_reverts() public {
        uint32[] memory domains = new uint32[](1);
        bytes32[] memory addresses = new bytes32[](1);
        domains[0] = 3000;
        addresses[0] = makeAddr("remote").addressToBytes32();
        vm.expectRevert(
            WormholeVaaHookIsm.CompleteWormholeEnrollmentRequired.selector
        );
        originRouter.enrollRemoteRouters(domains, addresses);
    }

    function test_unenroll_clearsPolicyAndDisablesNewTrafficBothDirections()
        public
    {
        (bytes memory message, ) = _dispatch();
        bytes memory metadata = _ismMetadata(message, 0);

        destinationRouter.unenrollRemoteRouter(ORIGIN);

        (uint16 whId, ) = destinationRouter.remoteRouterConfigs(ORIGIN);
        assertEq(whId, 0);
        (bool enrolled, ) = destinationRouter.remoteWormholeChains(WH_ORIGIN);
        assertFalse(enrolled);

        // Inbound disabled.
        vm.expectRevert();
        _verify(message, metadata);

        // Outbound disabled.
        originRouter.unenrollRemoteRouter(DESTINATION);
        vm.expectRevert();
        _dispatchOnly();
    }

    function test_unenroll_emitsRouteIdentity() public {
        vm.expectEmit(true, true, false, true, address(originRouter));
        emit WormholeVaaHookIsm.WormholeRemoteRouterUnenrolled(
            DESTINATION,
            address(destinationRouter).addressToBytes32(),
            WH_DESTINATION
        );

        originRouter.unenrollRemoteRouter(DESTINATION);
    }

    function test_batchUnenroll_emitsEachRouteIdentity() public {
        uint32 secondDomain = 3000;
        uint16 secondWormholeChainId = 77;
        address secondRemote = makeAddr("secondRouter");
        bytes32 secondDomainIsm = secondRemote.addressToBytes32();
        _enroll(
            originRouter,
            secondDomain,
            secondRemote,
            secondWormholeChainId
        );

        uint32[] memory domains = new uint32[](2);
        domains[0] = DESTINATION;
        domains[1] = secondDomain;

        vm.expectEmit(true, true, false, true, address(originRouter));
        emit WormholeVaaHookIsm.WormholeRemoteRouterUnenrolled(
            DESTINATION,
            address(destinationRouter).addressToBytes32(),
            WH_DESTINATION
        );
        vm.expectEmit(true, true, false, true, address(originRouter));
        emit WormholeVaaHookIsm.WormholeRemoteRouterUnenrolled(
            secondDomain,
            secondDomainIsm,
            secondWormholeChainId
        );

        originRouter.unenrollRemoteRouters(domains);
    }

    function test_unenroll_thenReenrollWithDifferentWormholeId() public {
        originRouter.unenrollRemoteRouter(DESTINATION);
        _enroll(originRouter, DESTINATION, address(destinationRouter), 77);
        (uint16 whId, ) = originRouter.remoteRouterConfigs(DESTINATION);
        assertEq(whId, 77);
    }

    function test_unenroll_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert("Ownable: caller is not the owner");
        originRouter.unenrollRemoteRouter(DESTINATION);
    }

    // ============ Metadata ============

    function test_supportsMetadata_rejectsFeeToken() public {
        bytes memory metadata = StandardHookMetadata.formatWithFeeToken(
            0,
            0,
            address(this),
            makeAddr("feeToken")
        );
        assertFalse(
            IPostDispatchHook(address(originRouter)).supportsMetadata(metadata)
        );
    }

    function test_supportsMetadata_acceptsDestinationValue() public view {
        bytes memory metadata = StandardHookMetadata.format(
            1 ether,
            0,
            address(this)
        );
        assertTrue(
            IPostDispatchHook(address(originRouter)).supportsMetadata(metadata)
        );
    }

    function test_supportsMetadata_acceptsEmptyAndStandard() public view {
        IPostDispatchHook hook = IPostDispatchHook(address(originRouter));
        assertTrue(hook.supportsMetadata(""));
        assertTrue(
            hook.supportsMetadata(
                StandardHookMetadata.format(0, 300_000, address(this))
            )
        );
    }

    // ============ Quote ============

    function test_quoteDispatch_isCoreFee() public {
        bytes memory message = originMailbox.buildOutboundMessage(
            DESTINATION,
            address(recipient).addressToBytes32(),
            _body()
        );
        assertEq(
            IPostDispatchHook(address(originRouter)).quoteDispatch("", message),
            CORE_FEE
        );
    }

    function test_quoteDispatch_tracksCoreFeeChanges() public {
        originCore.setMessageFee(CORE_FEE * 3);
        bytes memory message = originMailbox.buildOutboundMessage(
            DESTINATION,
            address(recipient).addressToBytes32(),
            _body()
        );
        assertEq(
            IPostDispatchHook(address(originRouter)).quoteDispatch("", message),
            CORE_FEE * 3
        );
    }

    function test_quoteDispatch_rejectsUnenrolledDestination() public {
        bytes memory message = originMailbox.buildOutboundMessage(
            3000,
            address(recipient).addressToBytes32(),
            _body()
        );
        vm.expectRevert();
        IPostDispatchHook(address(originRouter)).quoteDispatch("", message);
    }

    // ============ Publication ============

    function test_postDispatch_publishesExactPayload() public {
        bytes memory message = originMailbox.buildOutboundMessage(
            DESTINATION,
            address(recipient).addressToBytes32(),
            _body()
        );
        bytes memory expectedPayload = WormholeMessage.encode(
            ORIGIN,
            DESTINATION,
            address(destinationRouter).addressToBytes32(),
            message.id(),
            _nonce(message)
        );

        vm.expectEmit(true, false, false, true, address(originCore));
        emit ICoreBridge.LogMessagePublished(
            address(originRouter),
            0,
            _nonce(message),
            expectedPayload,
            CONSISTENCY
        );

        _dispatch();

        assertEq(address(originCore).balance, CORE_FEE);
        assertTrue(originRouter.publishedMessages(message.id()));
    }

    function test_postDispatch_emitsCorrelationEvent() public {
        bytes memory message = originMailbox.buildOutboundMessage(
            DESTINATION,
            address(recipient).addressToBytes32(),
            _body()
        );

        vm.expectEmit(true, true, false, true, address(originRouter));
        emit WormholeVaaHookIsm.WormholeMessagePublished(
            message.id(),
            DESTINATION,
            0,
            _nonce(message)
        );
        _dispatch();
    }

    function test_postDispatch_rejectsNonLatestDispatched() public {
        bytes memory message = originMailbox.buildOutboundMessage(
            DESTINATION,
            address(recipient).addressToBytes32(),
            _body()
        );
        vm.expectRevert(WormholeVaaHookIsm.MessageNotDispatched.selector);
        IPostDispatchHook(address(originRouter)).postDispatch{value: CORE_FEE}(
            "",
            message
        );
    }

    function test_postDispatch_rejectsRepublication() public {
        (bytes memory message, ) = _dispatch();
        // The message is still `latestDispatchedId`, so only the one-shot guard
        // stops a second publication.
        vm.expectRevert(WormholeVaaHookIsm.MessageAlreadyPublished.selector);
        IPostDispatchHook(address(originRouter)).postDispatch{value: CORE_FEE}(
            "",
            message
        );
    }

    function test_postDispatch_rejectsUnderpayment() public {
        uint256 required = CORE_FEE;
        vm.expectRevert(
            abi.encodeWithSelector(
                WormholeVaaHookIsm.InsufficientFee.selector,
                required,
                required - 1
            )
        );
        _dispatchOnly(required - 1);
    }

    function test_postDispatch_underpaymentDoesNotReachCore() public {
        uint256 required = CORE_FEE;
        // Forced balance must not let an underfunded caller publish.
        vm.deal(address(originRouter), 10 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                WormholeVaaHookIsm.InsufficientFee.selector,
                required,
                0
            )
        );
        _dispatchOnly(0);
        assertEq(originCore.nextSequence(address(originRouter)), 0);
    }

    function test_postDispatch_refundsOnlyThisCallsExcess() public {
        vm.deal(address(originRouter), 5 ether);
        uint256 required = CORE_FEE;
        uint256 balanceBefore = address(this).balance;

        _dispatch(required + 1 ether);

        assertEq(address(this).balance, balanceBefore - required);
        // Forced balance stays put.
        assertEq(address(originRouter).balance, 5 ether);
    }

    function test_postDispatch_coreFailureRollsBackPublicationState() public {
        bytes memory message = originMailbox.buildOutboundMessage(
            DESTINATION,
            address(recipient).addressToBytes32(),
            _body()
        );
        vm.mockCallRevert(
            address(originCore),
            abi.encodeWithSelector(ICoreBridge.publishMessage.selector),
            "Core publication failed"
        );
        vm.expectRevert("Core publication failed");
        _dispatchOnly();
        assertFalse(originRouter.publishedMessages(message.id()));
    }

    function test_handle_isUnsupported() public {
        vm.prank(address(destinationMailbox));
        vm.expectRevert(WormholeVaaHookIsm.HyperlaneHandleUnsupported.selector);
        destinationRouter.handle(
            ORIGIN,
            address(originRouter).addressToBytes32(),
            ""
        );
    }

    // ============ VAA validation ============

    function test_verify_acceptsValidVaa() public {
        (bytes memory message, ) = _dispatch();
        _verify(message, _ismMetadata(message, 0));
        assertTrue(_verify(message, _ismMetadata(message, 0)));
    }

    function test_verify_rejectsInvalidGuardianSet() public {
        (bytes memory message, ) = _dispatch();
        destinationCore.setGuardianSetLive(0, false);
        vm.expectRevert(
            abi.encodeWithSelector(
                WormholeVaaHookIsm.InvalidVaa.selector,
                "guardian set has expired"
            )
        );
        _verify(message, _ismMetadata(message, 0));
    }

    function test_verify_rejectsWrongEmitterChainId() public {
        (bytes memory message, ) = _dispatch();
        bytes memory metadata = _wrapVaa(
            _vaa(
                WH_ORIGIN + 1,
                address(originRouter).addressToBytes32(),
                0,
                _nonce(message),
                CONSISTENCY,
                0,
                _payloadFor(message)
            )
        );
        vm.expectRevert(WormholeVaaHookIsm.WrongEmitterChainId.selector);
        _verify(message, metadata);
    }

    function test_verify_rejectsWrongEmitterAddress() public {
        (bytes memory message, ) = _dispatch();
        bytes memory metadata = _wrapVaa(
            _vaa(
                WH_ORIGIN,
                makeAddr("impostor").addressToBytes32(),
                0,
                _nonce(message),
                CONSISTENCY,
                0,
                _payloadFor(message)
            )
        );
        vm.expectRevert(WormholeVaaHookIsm.WrongEmitterAddress.selector);
        _verify(message, metadata);
    }

    function test_verify_rejectsWrongConsistencyLevel() public {
        (bytes memory message, ) = _dispatch();
        bytes memory metadata = _wrapVaa(
            _vaa(
                WH_ORIGIN,
                address(originRouter).addressToBytes32(),
                0,
                _nonce(message),
                CONSISTENCY + 1,
                0,
                _payloadFor(message)
            )
        );
        vm.expectRevert(WormholeVaaHookIsm.WrongConsistencyLevel.selector);
        _verify(message, metadata);
    }

    function test_verify_rejectsWrongDestinationDomain() public {
        (bytes memory message, ) = _dispatch();
        bytes memory payload = WormholeMessage.encode(
            ORIGIN,
            DESTINATION + 1,
            address(destinationRouter).addressToBytes32(),
            message.id(),
            _nonce(message)
        );
        bytes memory metadata = _wrapVaa(
            _vaa(
                WH_ORIGIN,
                address(originRouter).addressToBytes32(),
                0,
                _nonce(message),
                CONSISTENCY,
                0,
                payload
            )
        );
        vm.expectRevert(WormholeVaaHookIsm.WrongDestinationDomain.selector);
        _verify(message, metadata);
    }

    function test_verify_rejectsWrongDestinationRouter() public {
        (bytes memory message, ) = _dispatch();
        bytes memory payload = WormholeMessage.encode(
            ORIGIN,
            DESTINATION,
            makeAddr("otherRouter").addressToBytes32(),
            message.id(),
            _nonce(message)
        );
        bytes memory metadata = _wrapVaa(
            _vaa(
                WH_ORIGIN,
                address(originRouter).addressToBytes32(),
                0,
                _nonce(message),
                CONSISTENCY,
                0,
                payload
            )
        );
        vm.expectRevert(WormholeVaaHookIsm.WrongDestinationRouter.selector);
        _verify(message, metadata);
    }

    function test_verify_rejectsWormholeNonceMismatch() public {
        (bytes memory message, ) = _dispatch();
        bytes memory metadata = _wrapVaa(
            _vaa(
                WH_ORIGIN,
                address(originRouter).addressToBytes32(),
                0,
                _nonce(message) + 1,
                CONSISTENCY,
                0,
                _payloadFor(message)
            )
        );
        vm.expectRevert(WormholeVaaHookIsm.WormholeNonceMismatch.selector);
        _verify(message, metadata);
    }

    function test_verify_rejectsUnenrolledOriginDomain() public {
        (bytes memory message, ) = _dispatch();
        bytes memory payload = WormholeMessage.encode(
            4321,
            DESTINATION,
            address(destinationRouter).addressToBytes32(),
            message.id(),
            _nonce(message)
        );
        bytes memory metadata = _wrapVaa(
            _vaa(
                WH_ORIGIN,
                address(originRouter).addressToBytes32(),
                0,
                _nonce(message),
                CONSISTENCY,
                0,
                payload
            )
        );
        vm.expectRevert();
        _verify(message, metadata);
    }

    function test_verify_rejectsWrongPayloadMagic() public {
        (bytes memory message, ) = _dispatch();
        bytes memory payload = abi.encode(
            WormholeMessage.Message({
                magic: bytes4("XXXX"),
                version: WormholeMessage.VERSION,
                originDomain: ORIGIN,
                destinationDomain: DESTINATION,
                destinationRouter: address(destinationRouter)
                    .addressToBytes32(),
                messageId: message.id(),
                nonce: _nonce(message)
            })
        );
        bytes memory metadata = _wrapVaa(
            _vaa(
                WH_ORIGIN,
                address(originRouter).addressToBytes32(),
                0,
                _nonce(message),
                CONSISTENCY,
                0,
                payload
            )
        );
        vm.expectRevert(WormholeMessage.InvalidPayloadMagic.selector);
        _verify(message, metadata);
    }

    function test_verify_rejectsWrongPayloadVersion() public {
        (bytes memory message, ) = _dispatch();
        bytes memory payload = abi.encode(
            WormholeMessage.Message({
                magic: WormholeMessage.MAGIC,
                version: WormholeMessage.VERSION + 1,
                originDomain: ORIGIN,
                destinationDomain: DESTINATION,
                destinationRouter: address(destinationRouter)
                    .addressToBytes32(),
                messageId: message.id(),
                nonce: _nonce(message)
            })
        );
        bytes memory metadata = _wrapVaa(
            _vaa(
                WH_ORIGIN,
                address(originRouter).addressToBytes32(),
                0,
                _nonce(message),
                CONSISTENCY,
                0,
                payload
            )
        );
        vm.expectRevert(WormholeMessage.InvalidPayloadVersion.selector);
        _verify(message, metadata);
    }

    function test_verify_rejectsWrongPayloadLength() public {
        (bytes memory message, ) = _dispatch();
        bytes memory metadata = _wrapVaa(
            _vaa(
                WH_ORIGIN,
                address(originRouter).addressToBytes32(),
                0,
                _nonce(message),
                CONSISTENCY,
                0,
                hex"deadbeef"
            )
        );
        vm.expectRevert(WormholeMessage.InvalidPayloadLength.selector);
        _verify(message, metadata);
    }

    function test_verify_rejectsTruncatedVaa() public {
        (bytes memory message, ) = _dispatch();
        vm.expectRevert();
        _verify(message, _wrapVaa(hex"0badc0de"));
    }

    // ============ Nonce policy ============

    function test_nonce_outOfOrderAndGapsSucceed() public {
        (bytes memory first, ) = _dispatch();
        (bytes memory second, ) = _dispatch();
        (bytes memory third, ) = _dispatch();

        // Deliver third, then first. Second is never delivered.
        _verify(third, _ismMetadata(third, 2));
        assertTrue(_verify(third, _ismMetadata(third, 2)));

        _verify(first, _ismMetadata(first, 0));
        assertTrue(_verify(first, _ismMetadata(first, 0)));

        assertGt(second.length, 0);
    }

    function _verify(
        bytes memory message,
        bytes memory metadata
    ) internal returns (bool) {
        return
            IInterchainSecurityModule(address(destinationRouter)).verify(
                metadata,
                message
            );
    }

    function _payloadFor(
        bytes memory message
    ) internal view returns (bytes memory) {
        return
            WormholeMessage.encode(
                _origin(message),
                _destination(message),
                address(destinationRouter).addressToBytes32(),
                message.id(),
                _nonce(message)
            );
    }

    receive() external payable {}

    string internal constant URL = "https://vaa.example/getWormholeVaa";

    function _urls() internal pure returns (string[] memory urls) {
        urls = new string[](1);
        urls[0] = URL;
    }

    function _deployRouter(
        address mailbox_,
        address core_
    ) internal returns (WormholeVaaHookIsm) {
        return
            new WormholeVaaHookIsm(
                mailbox_,
                core_,
                _consistencyLevelConfig(),
                _urls()
            );
    }

    function _enroll(
        WormholeVaaHookIsm router,
        uint32 domainId,
        address remote,
        uint16 wormholeChainId
    ) internal {
        WormholeVaaHookIsm(address(router)).enrollRemoteRouter(
            _remoteRouterConfig(domainId, remote, wormholeChainId)
        );
    }

    function _ismMetadata(
        bytes memory message,
        uint64 sequence
    ) internal view returns (bytes memory) {
        return _wrapVaa(_validVaa(message, sequence));
    }

    /// @dev Mirrors what `createAbiHandler` returns for `getWormholeVaa`.
    function _wrapVaa(
        bytes memory encodedVaa
    ) internal pure returns (bytes memory) {
        return abi.encode(encodedVaa);
    }

    function vaaRouter() internal view returns (WormholeVaaHookIsm) {
        return WormholeVaaHookIsm(address(destinationRouter));
    }

    // ============ CCIP read ============

    function test_moduleType_isCcipRead() public view {
        assertEq(
            IInterchainSecurityModule(address(destinationRouter)).moduleType(),
            uint8(IInterchainSecurityModule.Types.CCIP_READ)
        );
    }

    function test_urls_setInConstructorAndOwnerOnly() public {
        assertEq(vaaRouter().urls()[0], URL);

        string[] memory next = new string[](1);
        next[0] = "https://other.example/getWormholeVaa";
        vm.prank(alice);
        vm.expectRevert("Ownable: caller is not the owner");
        vaaRouter().setUrls(next);

        vaaRouter().setUrls(next);
        assertEq(vaaRouter().urls()[0], next[0]);
    }

    function test_constructor_rejectsEmptyUrls() public {
        string[] memory empty = new string[](0);
        vm.expectRevert("AbstractCcipReadIsm: urls cannot be empty");
        new WormholeVaaHookIsm(
            address(destinationMailbox),
            address(destinationCore),
            _consistencyLevelConfig(),
            empty
        );
    }

    function test_constructor_registersCustomConsistencyAtomically() public {
        MockCustomConsistencyLevel ccl = new MockCustomConsistencyLevel();
        WormholeConsistencyLevelConfig
            memory custom = WormholeConsistencyLevelConfig({
                consistencyLevel: 203,
                customConsistencyLevelContract: address(ccl),
                baseConsistencyLevel: 200,
                additionalBlocks: 2
            });

        WormholeVaaHookIsm router = new WormholeVaaHookIsm(
            address(destinationMailbox),
            address(destinationCore),
            custom,
            _urls()
        );

        bytes32 expected = bytes32(
            abi.encodePacked(uint8(1), uint8(200), uint16(2), bytes28(0))
        );
        assertEq(ccl.getConfiguration(address(router)), expected);
        assertEq(
            address(router.customConsistencyLevelContract()),
            address(ccl)
        );
        assertEq(router.consistencyLevel(), 203);
        assertEq(router.baseConsistencyLevel(), 200);
        assertEq(router.additionalBlocks(), 2);
    }

    function test_constructor_rejectsUnsupportedConsistencyLevel() public {
        WormholeConsistencyLevelConfig
            memory unsupported = WormholeConsistencyLevelConfig({
                consistencyLevel: 15,
                customConsistencyLevelContract: address(0),
                baseConsistencyLevel: 0,
                additionalBlocks: 0
            });
        vm.expectRevert(
            WormholeVaaHookIsm.InvalidConsistencyLevelConfig.selector
        );
        new WormholeVaaHookIsm(
            address(destinationMailbox),
            address(destinationCore),
            unsupported,
            _urls()
        );
    }

    function test_constructor_acceptsSdkFinalizedConsistencyLevel() public {
        WormholeConsistencyLevelConfig
            memory finalized = WormholeConsistencyLevelConfig({
                consistencyLevel: CONSISTENCY_LEVEL_FINALIZED,
                customConsistencyLevelContract: address(0),
                baseConsistencyLevel: 0,
                additionalBlocks: 0
            });

        WormholeVaaHookIsm router = new WormholeVaaHookIsm(
            address(destinationMailbox),
            address(destinationCore),
            finalized,
            _urls()
        );

        assertEq(router.consistencyLevel(), CONSISTENCY_LEVEL_FINALIZED);
    }

    function test_constructor_acceptsZeroFinalizedConsistencyLevel() public {
        WormholeConsistencyLevelConfig
            memory finalized = WormholeConsistencyLevelConfig({
                consistencyLevel: 0,
                customConsistencyLevelContract: address(0),
                baseConsistencyLevel: 0,
                additionalBlocks: 0
            });

        WormholeVaaHookIsm router = new WormholeVaaHookIsm(
            address(destinationMailbox),
            address(destinationCore),
            finalized,
            _urls()
        );

        assertEq(router.consistencyLevel(), 0);
    }

    function test_constructor_rejectsCustomConsistencyWithoutCcl() public {
        WormholeConsistencyLevelConfig
            memory incomplete = WormholeConsistencyLevelConfig({
                consistencyLevel: 203,
                customConsistencyLevelContract: address(0),
                baseConsistencyLevel: 200,
                additionalBlocks: 2
            });
        vm.expectRevert(
            WormholeVaaHookIsm.InvalidCustomConsistencyLevelContract.selector
        );
        new WormholeVaaHookIsm(
            address(destinationMailbox),
            address(destinationCore),
            incomplete,
            _urls()
        );
    }

    function test_constructor_rejectsCustomConsistencyWithCustomBase() public {
        MockCustomConsistencyLevel ccl = new MockCustomConsistencyLevel();
        WormholeConsistencyLevelConfig
            memory invalid = WormholeConsistencyLevelConfig({
                consistencyLevel: 203,
                customConsistencyLevelContract: address(ccl),
                baseConsistencyLevel: 203,
                additionalBlocks: 2
            });

        vm.expectRevert(
            WormholeVaaHookIsm.InvalidCustomConsistencyLevelConfig.selector
        );
        new WormholeVaaHookIsm(
            address(destinationMailbox),
            address(destinationCore),
            invalid,
            _urls()
        );
    }

    function test_constructor_rejectsSdkFinalizedAsCustomBase() public {
        MockCustomConsistencyLevel ccl = new MockCustomConsistencyLevel();
        WormholeConsistencyLevelConfig
            memory invalid = WormholeConsistencyLevelConfig({
                consistencyLevel: 203,
                customConsistencyLevelContract: address(ccl),
                baseConsistencyLevel: CONSISTENCY_LEVEL_FINALIZED,
                additionalBlocks: 2
            });

        vm.expectRevert(
            WormholeVaaHookIsm.InvalidCustomConsistencyLevelConfig.selector
        );
        new WormholeVaaHookIsm(
            address(destinationMailbox),
            address(destinationCore),
            invalid,
            _urls()
        );
    }

    function test_constructor_rejectsCustomSettingsForStandardConsistency()
        public
    {
        WormholeConsistencyLevelConfig
            memory invalid = WormholeConsistencyLevelConfig({
                consistencyLevel: CONSISTENCY,
                customConsistencyLevelContract: makeAddr("unusedCcl"),
                baseConsistencyLevel: 200,
                additionalBlocks: 2
            });

        vm.expectRevert(
            WormholeVaaHookIsm.UnexpectedCustomConsistencyLevelConfig.selector
        );
        new WormholeVaaHookIsm(
            address(destinationMailbox),
            address(destinationCore),
            invalid,
            _urls()
        );
    }

    function test_getOffchainVerifyInfo_encodesServiceCall() public {
        (bytes memory message, ) = _dispatch();
        vm.expectRevert(
            abi.encodeWithSelector(
                ICcipReadIsm.OffchainLookup.selector,
                address(destinationRouter),
                _urls(),
                abi.encodeCall(IWormholeVaaService.getWormholeVaa, (message)),
                IInterchainSecurityModule.verify.selector,
                message
            )
        );
        vaaRouter().getOffchainVerifyInfo(message);
    }

    // ============ Metadata shape ============

    function test_verify_rejectsRawVaaMetadata() public {
        (bytes memory message, ) = _dispatch();
        vm.expectRevert(WormholeVaaHookIsm.InvalidMetadata.selector);
        _verify(message, _validVaa(message, 0));
    }

    function test_verify_rejectsShortMetadata() public {
        (bytes memory message, ) = _dispatch();
        vm.expectRevert(WormholeVaaHookIsm.InvalidMetadata.selector);
        _verify(message, hex"00");
    }

    function test_verify_rejectsTrailingGarbage() public {
        (bytes memory message, ) = _dispatch();
        bytes memory metadata = abi.encodePacked(
            _wrapVaa(_validVaa(message, 0)),
            hex"deadbeef"
        );
        vm.expectRevert(WormholeVaaHookIsm.InvalidMetadata.selector);
        _verify(message, metadata);
    }

    // ============ Hyperlane binding ============

    function test_verify_rejectsMessageIdMismatch() public {
        (bytes memory message, ) = _dispatch();
        (bytes memory other, ) = _dispatch();
        vm.expectRevert(WormholeVaaHookIsm.WrongMessageId.selector);
        _verify(other, _ismMetadata(message, 0));
    }

    function test_verify_writesNoState() public {
        (bytes memory message, ) = _dispatch();
        bytes memory metadata = _ismMetadata(message, 0);
        bytes32 slot0Before = vm.load(address(destinationRouter), bytes32(0));
        assertTrue(_verify(message, metadata));
        // Repeated verification stays valid; the ISM is stateless.
        assertTrue(_verify(message, metadata));
        assertEq(vm.load(address(destinationRouter), bytes32(0)), slot0Before);
    }

    function test_process_succeedsAndRepeatFailsInMailbox() public {
        (bytes memory message, ) = _dispatch();
        bytes memory metadata = _ismMetadata(message, 0);

        destinationMailbox.process(metadata, message);
        assertTrue(destinationMailbox.delivered(message.id()));
        assertEq(recipient.lastData(), _body());

        vm.expectRevert("Mailbox: already delivered");
        destinationMailbox.process(metadata, message);
    }

    function test_dispatch_paysCoreFee() public {
        _dispatch();
        assertEq(address(originCore).balance, CORE_FEE);
    }
}

// ============================================================================
// Payload fuzzing
// ============================================================================

contract WormholeHookIsmTest_Payload is Test {
    function test_payload_encodedLength() public pure {
        bytes memory payload = WormholeMessage.encode(
            1,
            2,
            bytes32(uint256(3)),
            bytes32(uint256(4)),
            5
        );
        assertEq(payload.length, WormholeMessage.ENCODED_LENGTH);
    }

    function testFuzz_payload_roundTrip(
        uint32 originDomain,
        uint32 destinationDomain,
        bytes32 destinationRouter,
        bytes32 messageId,
        uint32 nonce
    ) public pure {
        bytes memory payload = WormholeMessage.encode(
            originDomain,
            destinationDomain,
            destinationRouter,
            messageId,
            nonce
        );
        WormholeMessage.Message memory decoded = WormholeMessage.decode(
            payload
        );

        assertEq(decoded.magic, WormholeMessage.MAGIC);
        assertEq(decoded.version, WormholeMessage.VERSION);
        assertEq(decoded.originDomain, originDomain);
        assertEq(decoded.destinationDomain, destinationDomain);
        assertEq(decoded.destinationRouter, destinationRouter);
        assertEq(decoded.messageId, messageId);
        assertEq(decoded.nonce, nonce);
    }

    function testFuzz_payload_rejectsWrongLength(uint8 extra) public {
        vm.assume(extra > 0);
        bytes memory payload = new bytes(
            WormholeMessage.ENCODED_LENGTH + extra
        );
        vm.expectRevert(WormholeMessage.InvalidPayloadLength.selector);
        this.decodePayload(payload);
    }

    function decodePayload(
        bytes calldata payload
    ) external pure returns (WormholeMessage.Message memory) {
        return WormholeMessage.decode(payload);
    }
}
