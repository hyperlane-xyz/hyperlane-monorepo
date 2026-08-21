// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.19;

import {Test} from "forge-std/Test.sol";

import {AbstractWormholeHookIsm} from "contracts/hooks/wormhole/AbstractWormholeHookIsm.sol";
import {WormholeExecutorHookIsm} from "contracts/hooks/wormhole/WormholeExecutorHookIsm.sol";
import {WormholeMessage} from "contracts/hooks/wormhole/WormholeMessage.sol";
import {WormholeVaaHookIsm} from "contracts/hooks/wormhole/WormholeVaaHookIsm.sol";
import {RelayInstructionLib, RequestLib} from "contracts/hooks/wormhole/libs/ExecutorRequest.sol";
import {WormholeConsistencyLevelConfig} from "contracts/hooks/wormhole/libs/CustomConsistencyLevel.sol";
import {StandardHookMetadata} from "contracts/hooks/libs/StandardHookMetadata.sol";
import {IInterchainSecurityModule} from "contracts/interfaces/IInterchainSecurityModule.sol";
import {IPostDispatchHook} from "contracts/interfaces/hooks/IPostDispatchHook.sol";
import {ICcipReadIsm} from "contracts/interfaces/isms/ICcipReadIsm.sol";
import {IWormholeHookIsm, RemoteRouterEnrollment} from "contracts/interfaces/wormhole/IWormholeHookIsm.sol";
import {IWormholeVaaService} from "contracts/interfaces/wormhole/IWormholeVaaService.sol";
import {CoreBridgeVM} from "contracts/interfaces/wormhole/ICoreBridge.sol";
import {Message} from "contracts/libs/Message.sol";
import {TypeCasts} from "contracts/libs/TypeCasts.sol";
import {MockExecutorQuoterRouter} from "contracts/mock/MockExecutorQuoterRouter.sol";
import {MockCustomConsistencyLevel} from "contracts/mock/MockCustomConsistencyLevel.sol";
import {MockWormholeCore} from "contracts/mock/MockWormholeCore.sol";
import {TestGasRouter} from "contracts/test/TestGasRouter.sol";
import {TestMailbox} from "contracts/test/TestMailbox.sol";
import {TestPostDispatchHook} from "contracts/test/TestPostDispatchHook.sol";
import {TestRecipient} from "contracts/test/TestRecipient.sol";

/**
 * @dev Shared fixture. Two Hyperlane domains, each with its own Mailbox and its
 * own Wormhole Core, and one combined router per domain. Concrete suites supply
 * the variant.
 */
abstract contract WormholeHookIsmTestBase is Test {
    using Message for bytes;
    using TypeCasts for address;

    uint32 internal constant ORIGIN = 1000;
    uint32 internal constant DESTINATION = 2000;
    uint16 internal constant WH_ORIGIN = 2;
    uint16 internal constant WH_DESTINATION = 30;
    uint8 internal constant CONSISTENCY = 202;
    uint256 internal constant CORE_FEE = 0.001 ether;
    uint128 internal constant CALLBACK_GAS = 300_000;

    TestMailbox internal originMailbox;
    TestMailbox internal destinationMailbox;
    MockWormholeCore internal originCore;
    MockWormholeCore internal destinationCore;
    MockExecutorQuoterRouter internal quoterRouter;
    TestPostDispatchHook internal noopHook;
    TestRecipient internal recipient;

    AbstractWormholeHookIsm internal originRouter;
    AbstractWormholeHookIsm internal destinationRouter;

    address internal owner = address(this);
    address internal alice = makeAddr("alice");
    address internal quoter = makeAddr("quoter");

    /// @dev Successful publications so far, mirroring the Core sequence.
    uint64 internal dispatchCount;

    function setUp() public virtual {
        originMailbox = new TestMailbox(ORIGIN);
        destinationMailbox = new TestMailbox(DESTINATION);
        originCore = new MockWormholeCore(WH_ORIGIN, CORE_FEE);
        destinationCore = new MockWormholeCore(WH_DESTINATION, CORE_FEE);
        quoterRouter = new MockExecutorQuoterRouter(_extraFee());
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

    // ============ Variant hooks ============

    function _deployRouter(
        address mailbox_,
        address core_
    ) internal virtual returns (AbstractWormholeHookIsm);

    function _enroll(
        AbstractWormholeHookIsm router,
        uint32 domain,
        address remote,
        uint16 wormholeChainId
    ) internal virtual;

    /// @dev Variant fee charged on top of Core's `messageFee()`.
    function _extraFee() internal pure virtual returns (uint256);

    // ============ Helpers ============

    function _consistencyLevelConfig()
        internal
        pure
        returns (WormholeConsistencyLevelConfig memory)
    {
        return
            WormholeConsistencyLevelConfig({
                consistencyLevel: CONSISTENCY,
                customConsistencyLevel: address(0),
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
        return _dispatch(CORE_FEE + _extraFee());
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
        _dispatchOnly(CORE_FEE + _extraFee());
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

    /// @dev Metadata the destination router accepts for `message`.
    function _ismMetadata(
        bytes memory message,
        uint64 sequence
    ) internal view virtual returns (bytes memory);

    function _enrollment(
        uint32 domain,
        address remote,
        uint16 wormholeChainId
    ) internal pure returns (RemoteRouterEnrollment memory) {
        return
            RemoteRouterEnrollment({
                domain: domain,
                router: TypeCasts.addressToBytes32(remote),
                wormholeChainId: wormholeChainId,
                expectedConsistencyLevel: CONSISTENCY
            });
    }
}

/**
 * @dev Behaviour owned by `AbstractWormholeHookIsm`. Every assertion here must
 * hold for both variants, so the suite is run twice.
 */
abstract contract WormholeHookIsmSharedTest is WormholeHookIsmTestBase {
    using Message for bytes;
    using TypeCasts for address;

    // ============ Construction ============

    function test_constructor_readsWormholeIdentity() public view {
        assertEq(address(originRouter.wormhole()), address(originCore));
        assertEq(originRouter.wormholeChainId(), WH_ORIGIN);
        assertEq(originRouter.consistencyLevel(), CONSISTENCY);
        assertEq(originRouter.localDomain(), ORIGIN);
    }

    function test_constructor_rejectsNonContractCore() public {
        vm.expectRevert(IWormholeHookIsm.InvalidWormholeCore.selector);
        _deployRouter(address(originMailbox), makeAddr("notACore"));
    }

    function test_constructor_rejectsZeroWormholeChainId() public {
        MockWormholeCore zeroCore = new MockWormholeCore(0, CORE_FEE);
        vm.expectRevert(IWormholeHookIsm.InvalidWormholeChainId.selector);
        _deployRouter(address(originMailbox), address(zeroCore));
    }

    function test_constructor_rejectsWrongEvmChainId() public {
        MockWormholeCore wrongChainCore = new MockWormholeCore(
            WH_ORIGIN,
            CORE_FEE
        );
        wrongChainCore.setEvmChainId(block.chainid + 1);
        vm.expectRevert(IWormholeHookIsm.InvalidWormholeEvmChainId.selector);
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
        assertEq(
            originRouter.hyperlaneDomainPlusOne(WH_DESTINATION),
            uint64(DESTINATION) + 1
        );
    }

    function test_enroll_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert("Ownable: caller is not the owner");
        _enroll(originRouter, 3000, makeAddr("remote"), 42);
    }

    function test_enroll_rejectsLocalDomain() public {
        vm.expectRevert(IWormholeHookIsm.InvalidRemoteDomain.selector);
        _enroll(originRouter, ORIGIN, makeAddr("remote"), 42);
    }

    function test_enroll_rejectsZeroRouter() public {
        vm.expectRevert(IWormholeHookIsm.InvalidRemoteRouter.selector);
        _enroll(originRouter, 3000, address(0), 42);
    }

    function test_enroll_rejectsZeroWormholeChainId() public {
        vm.expectRevert(IWormholeHookIsm.InvalidWormholeChainId.selector);
        _enroll(originRouter, 3000, makeAddr("remote"), 0);
    }

    function test_enroll_rejectsLocalWormholeChainId() public {
        vm.expectRevert(IWormholeHookIsm.InvalidRemoteWormholeChainId.selector);
        _enroll(originRouter, 3000, makeAddr("remote"), WH_ORIGIN);
    }

    function test_enroll_rejectsWormholeChainIdAlias() public {
        vm.expectRevert(
            IWormholeHookIsm.WormholeChainIdAlreadyEnrolled.selector
        );
        _enroll(originRouter, 3000, makeAddr("remote"), WH_DESTINATION);
    }

    function test_enroll_rejectsWormholeChainIdChangeInPlace() public {
        vm.expectRevert(
            IWormholeHookIsm.WormholeChainIdChangeRequiresUnenrollment.selector
        );
        _enroll(originRouter, DESTINATION, makeAddr("replacement"), 77);
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

        vm.expectRevert(IWormholeHookIsm.WrongEmitterAddress.selector);
        _authorize(message, metadata);
    }

    function test_baseTwoArgEnrollment_reverts() public {
        vm.expectRevert(IWormholeHookIsm.RichEnrollmentRequired.selector);
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
        vm.expectRevert(IWormholeHookIsm.RichEnrollmentRequired.selector);
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
        assertEq(destinationRouter.hyperlaneDomainPlusOne(WH_ORIGIN), 0);

        // Inbound disabled.
        vm.expectRevert();
        _authorize(message, metadata);

        // Outbound disabled.
        originRouter.unenrollRemoteRouter(DESTINATION);
        vm.expectRevert();
        _dispatchOnly();
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

    function test_supportsMetadata_rejectsDestinationValue() public view {
        bytes memory metadata = StandardHookMetadata.format(
            1 ether,
            0,
            address(this)
        );
        assertFalse(
            IPostDispatchHook(address(originRouter)).supportsMetadata(metadata)
        );
    }

    function test_supportsMetadata_acceptsEmptyAndStandard() public view {
        IPostDispatchHook hook = IPostDispatchHook(address(originRouter));
        assertTrue(hook.supportsMetadata(""));
        assertTrue(
            hook.supportsMetadata(
                StandardHookMetadata.format(0, CALLBACK_GAS, address(this))
            )
        );
    }

    // ============ Quote ============

    function test_quoteDispatch_isCoreFeePlusExtraFees() public {
        bytes memory message = originMailbox.buildOutboundMessage(
            DESTINATION,
            address(recipient).addressToBytes32(),
            _body()
        );
        assertEq(
            IPostDispatchHook(address(originRouter)).quoteDispatch("", message),
            CORE_FEE + _extraFee()
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
            CORE_FEE * 3 + _extraFee()
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
        emit MockWormholeCore.LogMessagePublished(
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
        emit IWormholeHookIsm.WormholeMessagePublished(
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
        vm.expectRevert(IWormholeHookIsm.MessageNotDispatched.selector);
        IPostDispatchHook(address(originRouter)).postDispatch{
            value: CORE_FEE + _extraFee()
        }("", message);
    }

    function test_postDispatch_rejectsRepublication() public {
        (bytes memory message, ) = _dispatch();
        // The message is still `latestDispatchedId`, so only the one-shot guard
        // stops a second publication.
        vm.expectRevert(IWormholeHookIsm.MessageAlreadyPublished.selector);
        IPostDispatchHook(address(originRouter)).postDispatch{
            value: CORE_FEE + _extraFee()
        }("", message);
    }

    function test_postDispatch_rejectsUnderpayment() public {
        uint256 required = CORE_FEE + _extraFee();
        vm.expectRevert(
            abi.encodeWithSelector(
                IWormholeHookIsm.InsufficientFee.selector,
                required,
                required - 1
            )
        );
        _dispatchOnly(required - 1);
    }

    function test_postDispatch_underpaymentDoesNotReachCore() public {
        uint256 required = CORE_FEE + _extraFee();
        // Forced balance must not let an underfunded caller publish.
        vm.deal(address(originRouter), 10 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                IWormholeHookIsm.InsufficientFee.selector,
                required,
                0
            )
        );
        _dispatchOnly(0);
        assertEq(originCore.nextSequence(address(originRouter)), 0);
    }

    function test_postDispatch_refundsOnlyThisCallsExcess() public {
        vm.deal(address(originRouter), 5 ether);
        uint256 required = CORE_FEE + _extraFee();
        uint256 balanceBefore = address(this).balance;

        _dispatch(required + 1 ether);

        assertEq(address(this).balance, balanceBefore - required);
        // Forced balance stays put.
        assertEq(address(originRouter).balance, 5 ether);
    }

    function test_postDispatch_rejectsMismatchedSequence() public {
        originCore.setSequenceOverride(true, 99);
        vm.expectRevert(
            abi.encodeWithSelector(
                IWormholeHookIsm.UnexpectedPublishedSequence.selector,
                uint64(0),
                uint64(99)
            )
        );
        _dispatchOnly();
    }

    function test_postDispatch_coreFailureRollsBackPublicationState() public {
        bytes memory message = originMailbox.buildOutboundMessage(
            DESTINATION,
            address(recipient).addressToBytes32(),
            _body()
        );
        originCore.setSequenceOverride(true, 99);
        vm.expectRevert();
        _dispatchOnly();
        assertFalse(originRouter.publishedMessages(message.id()));
    }

    function test_handle_isUnsupported() public {
        vm.prank(address(destinationMailbox));
        vm.expectRevert(IWormholeHookIsm.HyperlaneHandleUnsupported.selector);
        destinationRouter.handle(
            ORIGIN,
            address(originRouter).addressToBytes32(),
            ""
        );
    }

    // ============ VAA validation ============

    function test_verify_acceptsValidVaa() public {
        (bytes memory message, ) = _dispatch();
        _authorize(message, _ismMetadata(message, 0));
        assertTrue(_verify(message, _ismMetadata(message, 0)));
    }

    function test_verify_rejectsInvalidGuardianSet() public {
        (bytes memory message, ) = _dispatch();
        destinationCore.setGuardianSetLive(0, false);
        vm.expectRevert(
            abi.encodeWithSelector(
                IWormholeHookIsm.InvalidVaa.selector,
                "guardian set has expired"
            )
        );
        _authorize(message, _ismMetadata(message, 0));
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
        vm.expectRevert(IWormholeHookIsm.WrongEmitterChainId.selector);
        _authorize(message, metadata);
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
        vm.expectRevert(IWormholeHookIsm.WrongEmitterAddress.selector);
        _authorize(message, metadata);
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
        vm.expectRevert(IWormholeHookIsm.WrongConsistencyLevel.selector);
        _authorize(message, metadata);
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
        vm.expectRevert(IWormholeHookIsm.WrongDestinationDomain.selector);
        _authorize(message, metadata);
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
        vm.expectRevert(IWormholeHookIsm.WrongDestinationRouter.selector);
        _authorize(message, metadata);
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
        vm.expectRevert(IWormholeHookIsm.WormholeNonceMismatch.selector);
        _authorize(message, metadata);
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
        _authorize(message, metadata);
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
        _authorize(message, metadata);
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
        _authorize(message, metadata);
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
        _authorize(message, metadata);
    }

    function test_verify_rejectsTruncatedVaa() public {
        (bytes memory message, ) = _dispatch();
        vm.expectRevert();
        _authorize(message, _wrapVaa(hex"0badc0de"));
    }

    // ============ Nonce policy ============

    function test_nonce_outOfOrderAndGapsSucceed() public {
        (bytes memory first, ) = _dispatch();
        (bytes memory second, ) = _dispatch();
        (bytes memory third, ) = _dispatch();

        // Deliver third, then first. Second is never delivered.
        _authorize(third, _ismMetadata(third, 2));
        assertTrue(_verify(third, _ismMetadata(third, 2)));

        _authorize(first, _ismMetadata(first, 0));
        assertTrue(_verify(first, _ismMetadata(first, 0)));

        assertGt(second.length, 0);
    }

    // ============ Variant plumbing ============

    /// @dev Performs whatever destination-side step the variant needs before
    /// `verify` can succeed. For the direct-VAA variant this is a no-op.
    function _authorize(
        bytes memory message,
        bytes memory metadata
    ) internal virtual;

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

    function _wrapVaa(
        bytes memory encodedVaa
    ) internal view virtual returns (bytes memory);

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
}

// ============================================================================
// Executor variant
// ============================================================================

contract WormholeHookIsmTest_Executor is WormholeHookIsmSharedTest {
    using Message for bytes;
    using TypeCasts for address;

    function _deployRouter(
        address mailbox_,
        address core_
    ) internal override returns (AbstractWormholeHookIsm) {
        return
            new WormholeExecutorHookIsm(
                mailbox_,
                core_,
                _consistencyLevelConfig(),
                address(quoterRouter)
            );
    }

    function _enroll(
        AbstractWormholeHookIsm router,
        uint32 domain,
        address remote,
        uint16 wormholeChainId
    ) internal override {
        WormholeExecutorHookIsm(address(router)).enrollRemoteRouter(
            WormholeExecutorHookIsm.ExecutorRemoteRouterEnrollment({
                remoteRouter: _enrollment(domain, remote, wormholeChainId),
                quoter: quoter,
                callbackGasLimit: CALLBACK_GAS
            })
        );
    }

    function _extraFee() internal pure override returns (uint256) {
        return 0.002 ether;
    }

    /// @dev Hyperlane carries no metadata for this variant.
    function _ismMetadata(
        bytes memory,
        uint64
    ) internal view override returns (bytes memory) {
        return "";
    }

    function _wrapVaa(
        bytes memory encodedVaa
    ) internal pure override returns (bytes memory) {
        return encodedVaa;
    }

    /// @dev The callback is the authorization step; `metadata` carries the VAA
    /// only for the negative cases built by the shared suite.
    function _authorize(
        bytes memory message,
        bytes memory metadata
    ) internal override {
        bytes memory encodedVaa = metadata.length == 0
            ? _validVaa(message, _latestSequence())
            : metadata;
        WormholeExecutorHookIsm(address(destinationRouter)).executeVAAv1(
            encodedVaa
        );
    }

    /// @dev The shared suite dispatches in order, so the Core sequence of the
    /// latest publication is one less than the number of publications.
    function _latestSequence() internal view returns (uint64) {
        return dispatchCount == 0 ? 0 : dispatchCount - 1;
    }

    function executorRouter() internal view returns (WormholeExecutorHookIsm) {
        return WormholeExecutorHookIsm(address(destinationRouter));
    }

    // ============ Executor configuration ============

    function test_executorConfig_storedOnEnrollment() public view {
        (address storedQuoter, uint128 gasLimit) = WormholeExecutorHookIsm(
            address(originRouter)
        ).executorConfigs(DESTINATION);
        assertEq(storedQuoter, quoter);
        assertEq(gasLimit, CALLBACK_GAS);
    }

    function test_executorConfig_clearedOnUnenrollment() public {
        originRouter.unenrollRemoteRouter(DESTINATION);
        (address storedQuoter, uint128 gasLimit) = WormholeExecutorHookIsm(
            address(originRouter)
        ).executorConfigs(DESTINATION);
        assertEq(storedQuoter, address(0));
        assertEq(gasLimit, 0);
    }

    function test_enroll_rejectsZeroQuoter() public {
        vm.expectRevert(WormholeExecutorHookIsm.InvalidExecutorConfig.selector);
        WormholeExecutorHookIsm(address(originRouter)).enrollRemoteRouter(
            WormholeExecutorHookIsm.ExecutorRemoteRouterEnrollment({
                remoteRouter: _enrollment(3000, makeAddr("r"), 42),
                quoter: address(0),
                callbackGasLimit: CALLBACK_GAS
            })
        );
    }

    function test_enroll_rejectsZeroCallbackGas() public {
        vm.expectRevert(WormholeExecutorHookIsm.InvalidExecutorConfig.selector);
        WormholeExecutorHookIsm(address(originRouter)).enrollRemoteRouter(
            WormholeExecutorHookIsm.ExecutorRemoteRouterEnrollment({
                remoteRouter: _enrollment(3000, makeAddr("r"), 42),
                quoter: quoter,
                callbackGasLimit: 0
            })
        );
    }

    function test_batchEnroll_revertsEntirelyOnOneInvalidEntry() public {
        WormholeExecutorHookIsm.ExecutorRemoteRouterEnrollment[]
            memory enrollments = new WormholeExecutorHookIsm.ExecutorRemoteRouterEnrollment[](
                2
            );
        enrollments[0] = WormholeExecutorHookIsm
            .ExecutorRemoteRouterEnrollment({
                remoteRouter: _enrollment(3000, makeAddr("r3"), 42),
                quoter: quoter,
                callbackGasLimit: CALLBACK_GAS
            });
        enrollments[1] = WormholeExecutorHookIsm
            .ExecutorRemoteRouterEnrollment({
                remoteRouter: _enrollment(4000, address(0), 43),
                quoter: quoter,
                callbackGasLimit: CALLBACK_GAS
            });

        vm.expectRevert(IWormholeHookIsm.InvalidRemoteRouter.selector);
        WormholeExecutorHookIsm(address(originRouter)).enrollRemoteRouters(
            enrollments
        );
        assertEq(originRouter.routers(3000), bytes32(0));
    }

    function test_moduleType_isNull() public view {
        assertEq(
            IInterchainSecurityModule(address(destinationRouter)).moduleType(),
            uint8(IInterchainSecurityModule.Types.NULL)
        );
    }

    // ============ Request encoding ============

    function test_postDispatch_encodesExecutorRequest() public {
        (bytes memory message, ) = _dispatch();

        MockExecutorQuoterRouter.Request memory request = quoterRouter
            .lastRequest();
        assertEq(request.dstChain, WH_DESTINATION);
        assertEq(
            request.dstAddr,
            address(destinationRouter).addressToBytes32()
        );
        assertEq(request.refundAddr, address(this));
        assertEq(request.quoter, quoter);
        assertEq(
            request.requestBytes,
            RequestLib.encodeVaaMultiSigRequest(
                WH_ORIGIN,
                address(originRouter).addressToBytes32(),
                0
            )
        );
        assertEq(
            request.relayInstructions,
            RelayInstructionLib.encodeGas(CALLBACK_GAS, 0)
        );
        assertEq(request.value, _extraFee());
        assertGt(message.length, 0);
    }

    function test_postDispatch_ignoresMetadataGasOverride() public {
        // Mirrors GasRouter metadata: this is the recipient's `handle` budget,
        // not the gas required by the Executor's `executeVAAv1` callback.
        bytes memory metadata = StandardHookMetadata.format(0, 64_000, alice);
        originMailbox.dispatch{value: CORE_FEE + _extraFee()}(
            DESTINATION,
            address(recipient).addressToBytes32(),
            _body(),
            metadata,
            IPostDispatchHook(address(originRouter))
        );

        MockExecutorQuoterRouter.Request memory request = quoterRouter
            .lastRequest();
        assertEq(
            request.relayInstructions,
            RelayInstructionLib.encodeGas(CALLBACK_GAS, 0)
        );
        assertEq(request.refundAddr, alice);
    }

    function test_postDispatch_throughGasRouter_usesConfiguredCallbackGas()
        public
    {
        TestGasRouter app = new TestGasRouter(address(originMailbox));
        app.setHook(address(originRouter));
        app.enrollRemoteRouter(
            DESTINATION,
            address(recipient).addressToBytes32()
        );
        app.setDestinationGas(DESTINATION, 64_000);

        bytes memory expectedInstructions = RelayInstructionLib.encodeGas(
            CALLBACK_GAS,
            0
        );
        // The mock checks both quoteExecution and requestExecution. This proves
        // quote and payment use the same config-derived instructions.
        quoterRouter.setExpectedRelayInstructions(expectedInstructions);
        uint256 fee = app.quoteDispatch(DESTINATION, _body());
        assertEq(fee, CORE_FEE + _extraFee());

        app.dispatch{value: fee}(DESTINATION, _body());

        MockExecutorQuoterRouter.Request memory request = quoterRouter
            .lastRequest();
        assertEq(request.relayInstructions, expectedInstructions);
        assertEq(request.value, _extraFee());
    }

    function test_postDispatch_failedExecutorRequestRollsBackPublication()
        public
    {
        bytes memory message = originMailbox.buildOutboundMessage(
            DESTINATION,
            address(recipient).addressToBytes32(),
            _body()
        );
        quoterRouter.setRequestReverts(true);
        vm.expectRevert();
        _dispatchOnly();
        assertFalse(originRouter.publishedMessages(message.id()));
        assertEq(originCore.nextSequence(address(originRouter)), 0);
    }

    function test_quoteDispatch_revertingQuoterBlocksDispatch() public {
        quoterRouter.setQuoteReverts(true);
        vm.expectRevert();
        _dispatchOnly();
    }

    // ============ Callback ============

    function test_executeVAAv1_callableByArbitraryAccount() public {
        (bytes memory message, ) = _dispatch();
        vm.prank(alice);
        executorRouter().executeVAAv1(_validVaa(message, 0));
        assertEq(
            executorRouter().authorizations(ORIGIN, message.id()),
            uint64(_nonce(message)) + 1
        );
    }

    function test_executeVAAv1_rejectsValue() public {
        (bytes memory message, ) = _dispatch();
        vm.expectRevert(
            WormholeExecutorHookIsm.DestinationValueUnsupported.selector
        );
        executorRouter().executeVAAv1{value: 1}(_validVaa(message, 0));
    }

    function test_executeVAAv1_rejectsDuplicateVaa() public {
        (bytes memory message, ) = _dispatch();
        executorRouter().executeVAAv1(_validVaa(message, 0));
        vm.expectRevert(WormholeExecutorHookIsm.VaaAlreadyConsumed.selector);
        executorRouter().executeVAAv1(_validVaa(message, 0));
    }

    function test_executeVAAv1_rejectsSecondVaaForSameMessage() public {
        (bytes memory message, ) = _dispatch();
        executorRouter().executeVAAv1(_validVaa(message, 0));
        // Different sequence => different digest, same message ID.
        vm.expectRevert(
            WormholeExecutorHookIsm.MessageAlreadyAuthorized.selector
        );
        executorRouter().executeVAAv1(_validVaa(message, 7));
    }

    function test_authorization_storesNoncePlusOneIncludingZero() public {
        // A freshly deployed Mailbox starts at nonce 0.
        (bytes memory message, ) = _dispatch();
        assertEq(_nonce(message), 0);
        executorRouter().executeVAAv1(_validVaa(message, 0));
        assertEq(executorRouter().authorizations(ORIGIN, message.id()), 1);
    }

    function test_authorization_isNamespacedByAuthenticatedOrigin() public {
        uint32 claimedOrigin = ORIGIN + 1;
        uint32 nonce = 0;
        bytes memory forgedMessage = abi.encodePacked(
            destinationMailbox.VERSION(),
            nonce,
            claimedOrigin,
            address(this).addressToBytes32(),
            DESTINATION,
            address(recipient).addressToBytes32(),
            _body()
        );

        // The VAA is authenticated as originating from ORIGIN, but carries the
        // ID of a Hyperlane message that claims a different origin domain.
        bytes memory vaa = _vaa(
            WH_ORIGIN,
            address(originRouter).addressToBytes32(),
            0,
            nonce,
            CONSISTENCY,
            0,
            WormholeMessage.encode(
                ORIGIN,
                DESTINATION,
                address(destinationRouter).addressToBytes32(),
                forgedMessage.id(),
                nonce
            )
        );

        executorRouter().executeVAAv1(vaa);

        assertEq(
            executorRouter().authorizations(ORIGIN, forgedMessage.id()),
            uint64(nonce) + 1
        );
        assertEq(
            executorRouter().authorizations(claimedOrigin, forgedMessage.id()),
            0
        );
        assertFalse(_verify(forgedMessage, ""));
    }

    function test_verify_falseBeforeCallback() public {
        (bytes memory message, ) = _dispatch();
        assertFalse(_verify(message, ""));
    }

    function test_verify_falseForOtherMessage() public {
        (bytes memory first, ) = _dispatch();
        (bytes memory second, ) = _dispatch();
        executorRouter().executeVAAv1(_validVaa(first, 0));
        assertFalse(_verify(second, ""));
    }

    function test_process_failsBeforeCallbackSucceedsAfter() public {
        (bytes memory message, ) = _dispatch();

        vm.expectRevert("Mailbox: ISM verification failed");
        destinationMailbox.process("", message);

        executorRouter().executeVAAv1(_validVaa(message, 0));
        destinationMailbox.process("", message);

        assertTrue(destinationMailbox.delivered(message.id()));
        assertEq(recipient.lastData(), _body());
    }

    function test_authorizationRemainsValidAfterRouterUnenrollment() public {
        (bytes memory message, ) = _dispatch();
        executorRouter().executeVAAv1(_validVaa(message, 0));

        destinationRouter.unenrollRemoteRouter(ORIGIN);

        // A successful callback is the final Wormhole authorization step.
        // Unenrollment blocks new callbacks but does not revoke authorization
        // that was already established under the previous configuration.
        assertTrue(_verify(message, ""));
        destinationMailbox.process("", message);
        assertTrue(destinationMailbox.delivered(message.id()));
    }

    function test_verify_rejectsWrongLocalDestination() public {
        bytes memory message = originMailbox.buildOutboundMessage(
            3000,
            address(recipient).addressToBytes32(),
            _body()
        );
        vm.expectRevert(IWormholeHookIsm.WrongDestinationDomain.selector);
        _verify(message, "");
    }
}

// ============================================================================
// Direct-VAA variant
// ============================================================================

contract WormholeHookIsmTest_DirectVaa is WormholeHookIsmSharedTest {
    using Message for bytes;
    using TypeCasts for address;

    string internal constant URL = "https://vaa.example/getWormholeVaa";

    function _urls() internal pure returns (string[] memory urls) {
        urls = new string[](1);
        urls[0] = URL;
    }

    function _deployRouter(
        address mailbox_,
        address core_
    ) internal override returns (AbstractWormholeHookIsm) {
        return
            new WormholeVaaHookIsm(
                mailbox_,
                core_,
                _consistencyLevelConfig(),
                _urls()
            );
    }

    function _enroll(
        AbstractWormholeHookIsm router,
        uint32 domain,
        address remote,
        uint16 wormholeChainId
    ) internal override {
        WormholeVaaHookIsm(address(router)).enrollRemoteRouter(
            _enrollment(domain, remote, wormholeChainId)
        );
    }

    function _extraFee() internal pure override returns (uint256) {
        return 0;
    }

    function _ismMetadata(
        bytes memory message,
        uint64 sequence
    ) internal view override returns (bytes memory) {
        return _wrapVaa(_validVaa(message, sequence));
    }

    /// @dev Mirrors what `createAbiHandler` returns for `getWormholeVaa`.
    function _wrapVaa(
        bytes memory encodedVaa
    ) internal pure override returns (bytes memory) {
        return abi.encode(encodedVaa);
    }

    /// @dev Verification is atomic; no destination step precedes it.
    function _authorize(
        bytes memory message,
        bytes memory metadata
    ) internal override {
        _verify(message, metadata);
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
                customConsistencyLevel: address(ccl),
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
        assertEq(address(router.customConsistencyLevel()), address(ccl));
        assertEq(router.consistencyLevel(), 203);
        assertEq(router.baseConsistencyLevel(), 200);
        assertEq(router.additionalBlocks(), 2);
    }

    function test_constructor_rejectsUnsupportedConsistencyLevel() public {
        WormholeConsistencyLevelConfig
            memory unsupported = WormholeConsistencyLevelConfig({
                consistencyLevel: 15,
                customConsistencyLevel: address(0),
                baseConsistencyLevel: 0,
                additionalBlocks: 0
            });
        vm.expectRevert(
            IWormholeHookIsm.InvalidCustomConsistencyLevelConfig.selector
        );
        new WormholeVaaHookIsm(
            address(destinationMailbox),
            address(destinationCore),
            unsupported,
            _urls()
        );
    }

    function test_constructor_rejectsCustomConsistencyWithoutCcl() public {
        WormholeConsistencyLevelConfig
            memory incomplete = WormholeConsistencyLevelConfig({
                consistencyLevel: 203,
                customConsistencyLevel: address(0),
                baseConsistencyLevel: 200,
                additionalBlocks: 2
            });
        vm.expectRevert(
            IWormholeHookIsm.InvalidCustomConsistencyLevel.selector
        );
        new WormholeVaaHookIsm(
            address(destinationMailbox),
            address(destinationCore),
            incomplete,
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
        vm.expectRevert(IWormholeHookIsm.WrongMessageId.selector);
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

    function test_quote_isCoreFeeOnlyAndNoExecutorCall() public {
        _dispatch();
        assertEq(quoterRouter.requestCount(), 0);
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
