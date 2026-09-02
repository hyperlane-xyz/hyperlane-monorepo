// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {Origin as LayerZeroOrigin} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {SetConfigParam as LayerZeroSetConfigParam} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/IMessageLibManager.sol";
import {GUID} from "@layerzerolabs/lz-evm-protocol-v2/contracts/libs/GUID.sol";
import {PacketV1Codec} from "@layerzerolabs/lz-evm-protocol-v2/contracts/messagelib/libs/PacketV1Codec.sol";
import {AbstractLayerZeroV2HookIsm} from "contracts/hooks/layerzero/AbstractLayerZeroV2HookIsm.sol";
import {LayerZeroV2CallbackHookIsm} from "contracts/hooks/layerzero/LayerZeroV2CallbackHookIsm.sol";
import {LayerZeroV2CcipReadHookIsm} from "contracts/hooks/layerzero/LayerZeroV2CcipReadHookIsm.sol";
import {IPostDispatchHook} from "contracts/interfaces/hooks/IPostDispatchHook.sol";
import {ICcipReadIsm} from "contracts/interfaces/isms/ICcipReadIsm.sol";
import {LayerZeroMessage} from "contracts/libs/LayerZeroMessage.sol";
import {LayerZeroMetadata} from "contracts/libs/LayerZeroMetadata.sol";
import {Message} from "contracts/libs/Message.sol";
import {TypeCasts} from "contracts/libs/TypeCasts.sol";
import {StandardHookMetadata} from "contracts/hooks/libs/StandardHookMetadata.sol";
import {MockLayerZeroEndpointV2} from "contracts/mock/MockLayerZeroEndpointV2.sol";
import {MockLayerZeroReceiveUln} from "contracts/mock/MockLayerZeroReceiveUln.sol";
import {TestMailbox} from "contracts/test/TestMailbox.sol";
import {TestPostDispatchHook} from "contracts/test/TestPostDispatchHook.sol";
import {TestRecipient} from "contracts/test/TestRecipient.sol";

abstract contract LayerZeroV2HookIsmTestBase is Test {
    using Message for bytes;
    using TypeCasts for address;

    uint32 internal constant ORIGIN = 1000;
    uint32 internal constant DESTINATION = 2000;
    uint32 internal constant SECOND_DESTINATION = 2001;
    uint32 internal constant ORIGIN_EID = 30101;
    uint32 internal constant DESTINATION_EID = 30111;
    uint32 internal constant SECOND_DESTINATION_EID = 30112;
    uint128 internal constant CALLBACK_GAS = 250_000;
    uint256 internal constant NATIVE_FEE = 0.01 ether;
    uint256 internal constant EIP_170_MAX_CODE_SIZE = 24_576;

    TestMailbox internal originMailbox;
    TestMailbox internal destinationMailbox;
    MockLayerZeroEndpointV2 internal originEndpoint;
    MockLayerZeroEndpointV2 internal destinationEndpoint;
    MockLayerZeroReceiveUln internal originUln;
    MockLayerZeroReceiveUln internal destinationUln;
    TestPostDispatchHook internal noopHook;
    TestRecipient internal recipient;
    AbstractLayerZeroV2HookIsm internal originRouter;
    AbstractLayerZeroV2HookIsm internal destinationRouter;

    function setUp() public virtual {
        originMailbox = new TestMailbox(ORIGIN);
        destinationMailbox = new TestMailbox(DESTINATION);
        originEndpoint = new MockLayerZeroEndpointV2(ORIGIN_EID);
        destinationEndpoint = new MockLayerZeroEndpointV2(DESTINATION_EID);
        originUln = new MockLayerZeroReceiveUln(address(originEndpoint));
        destinationUln = new MockLayerZeroReceiveUln(
            address(destinationEndpoint)
        );
        originEndpoint.registerMockLibrary(address(originUln));
        destinationEndpoint.registerMockLibrary(address(destinationUln));
        noopHook = new TestPostDispatchHook();
        recipient = new TestRecipient();

        originMailbox.setDefaultHook(address(noopHook));
        originMailbox.setRequiredHook(address(noopHook));
        destinationMailbox.setDefaultHook(address(noopHook));
        destinationMailbox.setRequiredHook(address(noopHook));
        destinationMailbox.setDefaultIsm(address(noopHook));

        originRouter = _deploy(address(originMailbox), address(originEndpoint));
        destinationRouter = _deploy(
            address(destinationMailbox),
            address(destinationEndpoint)
        );
        _configure(
            originRouter,
            originEndpoint,
            originUln,
            DESTINATION,
            DESTINATION_EID,
            address(destinationRouter)
        );
        _configure(
            destinationRouter,
            destinationEndpoint,
            destinationUln,
            ORIGIN,
            ORIGIN_EID,
            address(originRouter)
        );
        recipient.setInterchainSecurityModule(address(destinationRouter));
        vm.deal(address(this), 10 ether);
    }

    function _deploy(
        address mailbox,
        address endpoint
    ) internal virtual returns (AbstractLayerZeroV2HookIsm);

    function _enrollVariant(
        AbstractLayerZeroV2HookIsm router,
        AbstractLayerZeroV2HookIsm.RemoteRouterEnrollment memory enrollment
    ) internal virtual;

    function _updateVariant(
        AbstractLayerZeroV2HookIsm router,
        AbstractLayerZeroV2HookIsm.RemoteRouterConfigUpdate memory update_
    ) internal virtual;

    function _updateVariants(
        AbstractLayerZeroV2HookIsm router,
        AbstractLayerZeroV2HookIsm.RemoteRouterConfigUpdate[] memory updates
    ) internal virtual;

    function _configure(
        AbstractLayerZeroV2HookIsm router,
        MockLayerZeroEndpointV2,
        MockLayerZeroReceiveUln uln,
        uint32 domain,
        uint32 eid,
        address remote
    ) internal {
        LayerZeroSetConfigParam[]
            memory emptyConfig = new LayerZeroSetConfigParam[](0);
        _enrollVariant(
            router,
            AbstractLayerZeroV2HookIsm.RemoteRouterEnrollment({
                domain: domain,
                router: remote.addressToBytes32(),
                eid: eid,
                sendLibrary: address(uln),
                receiveLibrary: address(uln),
                receiveLibraryGracePeriod: 0,
                receiveLibraryTimeout: address(0),
                receiveLibraryTimeoutExpiry: 0,
                sendConfig: emptyConfig,
                receiveConfig: emptyConfig
            })
        );
    }

    function _dispatch()
        internal
        returns (bytes memory message, bytes32 messageId)
    {
        bytes memory body = bytes("hyperlane over layerzero");
        message = originMailbox.buildOutboundMessage(
            DESTINATION,
            address(recipient).addressToBytes32(),
            body
        );
        messageId = message.id();
        originMailbox.dispatch{value: NATIVE_FEE}(
            DESTINATION,
            address(recipient).addressToBytes32(),
            body,
            "",
            IPostDispatchHook(address(originRouter))
        );
    }

    function _defaultEnrollment()
        internal
        view
        returns (AbstractLayerZeroV2HookIsm.RemoteRouterEnrollment memory)
    {
        LayerZeroSetConfigParam[]
            memory emptyConfig = new LayerZeroSetConfigParam[](0);
        return
            AbstractLayerZeroV2HookIsm.RemoteRouterEnrollment({
                domain: DESTINATION,
                router: address(destinationRouter).addressToBytes32(),
                eid: DESTINATION_EID,
                sendLibrary: address(originUln),
                receiveLibrary: address(originUln),
                receiveLibraryGracePeriod: 0,
                receiveLibraryTimeout: address(0),
                receiveLibraryTimeoutExpiry: 0,
                sendConfig: emptyConfig,
                receiveConfig: emptyConfig
            });
    }

    function testConstructorRejectsInvalidEndpoints() public {
        vm.expectRevert(
            AbstractLayerZeroV2HookIsm.InvalidLayerZeroEndpoint.selector
        );
        _deploy(address(originMailbox), address(0));

        MockLayerZeroEndpointV2 zeroEidEndpoint = new MockLayerZeroEndpointV2(
            0
        );
        vm.expectRevert(AbstractLayerZeroV2HookIsm.InvalidLocalEid.selector);
        _deploy(address(originMailbox), address(zeroEidEndpoint));

        MockLayerZeroEndpointV2 tokenEndpoint = new MockLayerZeroEndpointV2(
            ORIGIN_EID
        );
        tokenEndpoint.setNativeToken(address(0xBEEF));
        vm.expectRevert(
            abi.encodeWithSelector(
                AbstractLayerZeroV2HookIsm
                    .UnsupportedNativeTokenEndpoint
                    .selector,
                address(0xBEEF)
            )
        );
        _deploy(address(originMailbox), address(tokenEndpoint));
    }

    function testHookTypeAndPathInitialization() public view {
        assertEq(
            originRouter.hookType(),
            uint8(IPostDispatchHook.HookTypes.LAYER_ZERO)
        );
        assertTrue(
            originRouter.allowInitializePath(
                LayerZeroOrigin({
                    srcEid: DESTINATION_EID,
                    sender: address(destinationRouter).addressToBytes32(),
                    nonce: 1
                })
            )
        );
        assertFalse(
            originRouter.allowInitializePath(
                LayerZeroOrigin({
                    srcEid: DESTINATION_EID,
                    sender: address(0xBEEF).addressToBytes32(),
                    nonce: 1
                })
            )
        );
        assertFalse(
            originRouter.allowInitializePath(
                LayerZeroOrigin({
                    srcEid: SECOND_DESTINATION_EID,
                    sender: bytes32(0),
                    nonce: 1
                })
            )
        );
    }

    function testRejectsPartialEnrollmentAndUnsupportedHandle() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                AbstractLayerZeroV2HookIsm.IncompleteLayerZeroRoute.selector,
                0
            )
        );
        originRouter.enrollRemoteRouter(
            SECOND_DESTINATION,
            address(0xBEEF).addressToBytes32()
        );

        vm.prank(address(originMailbox));
        vm.expectRevert(
            AbstractLayerZeroV2HookIsm.HyperlaneHandleUnsupported.selector
        );
        originRouter.handle(
            DESTINATION,
            address(destinationRouter).addressToBytes32(),
            ""
        );
    }

    function testUnenrollClearsRouteAndRejectsUnknownRoute() public {
        originRouter.unenrollRemoteRouter(DESTINATION);
        assertEq(originRouter.routers(DESTINATION), bytes32(0));
        uint32 eid = originRouter.remoteConfigs(DESTINATION);
        assertEq(eid, 0);
        assertEq(originRouter.domainsByEid(DESTINATION_EID), 0);

        vm.expectRevert(
            abi.encodeWithSelector(
                AbstractLayerZeroV2HookIsm.UnknownLayerZeroRoute.selector,
                DESTINATION
            )
        );
        originRouter.unenrollRemoteRouter(DESTINATION);
    }

    function testEnrollmentValidation() public {
        AbstractLayerZeroV2HookIsm.RemoteRouterEnrollment
            memory enrollment = _defaultEnrollment();

        enrollment.domain = ORIGIN;
        vm.expectRevert(
            abi.encodeWithSelector(
                AbstractLayerZeroV2HookIsm.InvalidRemoteDomain.selector,
                ORIGIN
            )
        );
        _enrollVariant(originRouter, enrollment);

        enrollment = _defaultEnrollment();
        enrollment.eid = ORIGIN_EID;
        vm.expectRevert(
            abi.encodeWithSelector(
                AbstractLayerZeroV2HookIsm.InvalidRemoteEid.selector,
                ORIGIN_EID
            )
        );
        _enrollVariant(originRouter, enrollment);

        enrollment = _defaultEnrollment();
        enrollment.router = bytes32(type(uint256).max);
        vm.expectRevert(
            abi.encodeWithSelector(
                AbstractLayerZeroV2HookIsm.NonCanonicalLayerZeroPeer.selector,
                bytes32(type(uint256).max)
            )
        );
        _enrollVariant(originRouter, enrollment);

        enrollment = _defaultEnrollment();
        enrollment.eid = SECOND_DESTINATION_EID;
        vm.expectRevert(
            abi.encodeWithSelector(
                AbstractLayerZeroV2HookIsm
                    .LayerZeroEidChangeRequiresUnenrollment
                    .selector,
                DESTINATION
            )
        );
        _enrollVariant(originRouter, enrollment);

        enrollment = _defaultEnrollment();
        enrollment.domain = SECOND_DESTINATION;
        enrollment.router = address(0xBEEF).addressToBytes32();
        vm.expectRevert(
            abi.encodeWithSelector(
                AbstractLayerZeroV2HookIsm.LayerZeroEidAlreadyEnrolled.selector,
                DESTINATION_EID,
                DESTINATION
            )
        );
        _enrollVariant(originRouter, enrollment);

        enrollment = _defaultEnrollment();
        enrollment.receiveLibraryGracePeriod = 1;
        vm.expectRevert(
            AbstractLayerZeroV2HookIsm
                .InvalidLayerZeroReceiveLibraryGracePeriod
                .selector
        );
        _enrollVariant(originRouter, enrollment);
    }

    function testRejectsMismatchedReceiveLibraryTimeout() public {
        AbstractLayerZeroV2HookIsm.RemoteRouterEnrollment
            memory enrollment = _defaultEnrollment();
        enrollment.receiveLibraryTimeout = address(originUln);
        vm.expectRevert(
            AbstractLayerZeroV2HookIsm
                .InvalidLayerZeroReceiveLibraryTimeout
                .selector
        );
        _enrollVariant(originRouter, enrollment);

        enrollment = _defaultEnrollment();
        enrollment.receiveLibraryTimeoutExpiry = block.number + 1;
        vm.expectRevert(
            AbstractLayerZeroV2HookIsm
                .InvalidLayerZeroReceiveLibraryTimeout
                .selector
        );
        _enrollVariant(originRouter, enrollment);
    }

    function testDispatchRejectsInvalidStateAndFees() public {
        bytes memory message = originMailbox.buildOutboundMessage(
            DESTINATION,
            address(recipient).addressToBytes32(),
            bytes("not dispatched")
        );
        bytes32 messageId = message.id();
        vm.expectRevert(
            abi.encodeWithSelector(
                AbstractLayerZeroV2HookIsm.MessageNotLatestDispatched.selector,
                messageId
            )
        );
        originRouter.postDispatch{value: NATIVE_FEE}("", message);

        vm.expectRevert(
            abi.encodeWithSelector(
                AbstractLayerZeroV2HookIsm.InsufficientLayerZeroFee.selector,
                NATIVE_FEE,
                0
            )
        );
        originMailbox.dispatch(
            DESTINATION,
            address(recipient).addressToBytes32(),
            bytes("insufficient"),
            "",
            IPostDispatchHook(address(originRouter))
        );

        (message, messageId) = _dispatch();
        vm.expectRevert(
            abi.encodeWithSelector(
                AbstractLayerZeroV2HookIsm
                    .LayerZeroAuthorizationAlreadySent
                    .selector,
                messageId
            )
        );
        originRouter.postDispatch{value: NATIVE_FEE}("", message);
    }

    function testRejectsLayerZeroTokenFees() public {
        bytes memory message = originMailbox.buildOutboundMessage(
            DESTINATION,
            address(recipient).addressToBytes32(),
            bytes("lz token fee")
        );
        originEndpoint.setLzTokenFee(1);
        vm.expectRevert(
            abi.encodeWithSelector(
                AbstractLayerZeroV2HookIsm
                    .UnsupportedLayerZeroTokenFee
                    .selector,
                1
            )
        );
        originRouter.quoteDispatch("", message);

        vm.expectRevert(
            abi.encodeWithSelector(
                AbstractLayerZeroV2HookIsm
                    .UnsupportedLayerZeroTokenFee
                    .selector,
                1
            )
        );
        originMailbox.dispatch{value: NATIVE_FEE}(
            DESTINATION,
            address(recipient).addressToBytes32(),
            bytes("lz token fee"),
            "",
            IPostDispatchHook(address(originRouter))
        );
    }

    function testRejectsUnsupportedMetadata() public view {
        bytes memory metadata = StandardHookMetadata.formatWithFeeToken(
            0,
            0,
            address(this),
            address(0xBEEF)
        );
        assertFalse(originRouter.supportsMetadata(metadata));
        metadata = StandardHookMetadata.overrideMsgValue(1);
        assertFalse(originRouter.supportsMetadata(metadata));
    }

    function testConfigurationRemainsMutable() public {
        assertEq(originEndpoint.delegates(address(originRouter)), address(0));
        MockLayerZeroReceiveUln replacement = new MockLayerZeroReceiveUln(
            address(originEndpoint)
        );
        originEndpoint.registerMockLibrary(address(replacement));
        LayerZeroSetConfigParam[]
            memory emptyConfig = new LayerZeroSetConfigParam[](0);
        _enrollVariant(
            originRouter,
            AbstractLayerZeroV2HookIsm.RemoteRouterEnrollment({
                domain: DESTINATION,
                router: address(destinationRouter).addressToBytes32(),
                eid: DESTINATION_EID,
                sendLibrary: address(replacement),
                receiveLibrary: address(originUln),
                receiveLibraryGracePeriod: 0,
                receiveLibraryTimeout: address(0),
                receiveLibraryTimeoutExpiry: 0,
                sendConfig: emptyConfig,
                receiveConfig: emptyConfig
            })
        );
        assertEq(
            originEndpoint.getSendLibrary(
                address(originRouter),
                DESTINATION_EID
            ),
            address(replacement)
        );
        (address receiveLibrary, ) = originEndpoint.getReceiveLibrary(
            address(originRouter),
            DESTINATION_EID
        );
        assertEq(receiveLibrary, address(originUln));
    }

    function testReceiveLibraryTimeoutUsesAbsoluteBlockExpiry() public {
        MockLayerZeroReceiveUln graceLibrary = new MockLayerZeroReceiveUln(
            address(originEndpoint)
        );
        originEndpoint.registerMockLibrary(address(graceLibrary));
        uint256 expiry = block.number + 10;
        LayerZeroSetConfigParam[]
            memory emptyConfig = new LayerZeroSetConfigParam[](0);
        _updateVariant(
            originRouter,
            AbstractLayerZeroV2HookIsm.RemoteRouterConfigUpdate({
                domain: DESTINATION,
                router: address(destinationRouter).addressToBytes32(),
                receiveLibraryTimeout: address(graceLibrary),
                receiveLibraryTimeoutExpiry: expiry,
                sendConfig: emptyConfig,
                receiveConfig: emptyConfig
            })
        );
        (address timeoutLibrary, uint256 actualExpiry) = originEndpoint
            .receiveLibraryTimeout(address(originRouter), DESTINATION_EID);
        assertEq(timeoutLibrary, address(graceLibrary));
        assertEq(actualExpiry, expiry);
        assertTrue(
            originEndpoint.isValidReceiveLibrary(
                address(originRouter),
                DESTINATION_EID,
                address(graceLibrary)
            )
        );
        vm.roll(expiry);
        assertFalse(
            originEndpoint.isValidReceiveLibrary(
                address(originRouter),
                DESTINATION_EID,
                address(graceLibrary)
            )
        );

        _updateVariant(
            originRouter,
            AbstractLayerZeroV2HookIsm.RemoteRouterConfigUpdate({
                domain: DESTINATION,
                router: address(destinationRouter).addressToBytes32(),
                receiveLibraryTimeout: address(0),
                receiveLibraryTimeoutExpiry: 0,
                sendConfig: emptyConfig,
                receiveConfig: emptyConfig
            })
        );
        (timeoutLibrary, actualExpiry) = originEndpoint.receiveLibraryTimeout(
            address(originRouter),
            DESTINATION_EID
        );
        assertEq(timeoutLibrary, address(0));
        assertEq(actualExpiry, 0);
    }

    function testConfigOnlyUpdateIsAtomicAndPreservesLibraries() public {
        bytes32 newRouter = address(0x1234).addressToBytes32();
        LayerZeroSetConfigParam[]
            memory sendConfig = new LayerZeroSetConfigParam[](1);
        sendConfig[0] = LayerZeroSetConfigParam({
            eid: DESTINATION_EID,
            configType: 1,
            config: hex"1234"
        });
        LayerZeroSetConfigParam[]
            memory receiveConfig = new LayerZeroSetConfigParam[](1);
        receiveConfig[0] = LayerZeroSetConfigParam({
            eid: DESTINATION_EID,
            configType: 2,
            config: hex"abcd"
        });
        uint256 expiry = block.number + 10;

        _updateVariant(
            originRouter,
            AbstractLayerZeroV2HookIsm.RemoteRouterConfigUpdate({
                domain: DESTINATION,
                router: newRouter,
                receiveLibraryTimeout: address(originUln),
                receiveLibraryTimeoutExpiry: expiry,
                sendConfig: sendConfig,
                receiveConfig: receiveConfig
            })
        );

        assertEq(originRouter.routers(DESTINATION), newRouter);
        assertEq(
            originEndpoint.getSendLibrary(
                address(originRouter),
                DESTINATION_EID
            ),
            address(originUln)
        );
        (address receiveLibrary, ) = originEndpoint.getReceiveLibrary(
            address(originRouter),
            DESTINATION_EID
        );
        assertEq(receiveLibrary, address(originUln));
        assertEq(
            originEndpoint.getConfig(
                address(originRouter),
                address(originUln),
                DESTINATION_EID,
                1
            ),
            hex"1234"
        );
        assertEq(
            originEndpoint.getConfig(
                address(originRouter),
                address(originUln),
                DESTINATION_EID,
                2
            ),
            hex"abcd"
        );
    }

    function testConfigOnlyUpdateRollsBackOnInvalidConfigEid() public {
        bytes32 currentRouter = originRouter.routers(DESTINATION);
        LayerZeroSetConfigParam[]
            memory sendConfig = new LayerZeroSetConfigParam[](1);
        sendConfig[0] = LayerZeroSetConfigParam({
            eid: ORIGIN_EID,
            configType: 1,
            config: hex"1234"
        });
        LayerZeroSetConfigParam[]
            memory emptyConfig = new LayerZeroSetConfigParam[](0);

        vm.expectRevert(
            abi.encodeWithSelector(
                AbstractLayerZeroV2HookIsm.InvalidLayerZeroConfigEid.selector,
                ORIGIN_EID
            )
        );
        _updateVariant(
            originRouter,
            AbstractLayerZeroV2HookIsm.RemoteRouterConfigUpdate({
                domain: DESTINATION,
                router: address(0x1234).addressToBytes32(),
                receiveLibraryTimeout: address(0),
                receiveLibraryTimeoutExpiry: 0,
                sendConfig: sendConfig,
                receiveConfig: emptyConfig
            })
        );
        assertEq(originRouter.routers(DESTINATION), currentRouter);
    }

    function testBatchConfigUpdateIsAtomic() public {
        _configure(
            originRouter,
            originEndpoint,
            originUln,
            SECOND_DESTINATION,
            SECOND_DESTINATION_EID,
            address(0xABCD)
        );
        LayerZeroSetConfigParam[]
            memory emptyConfig = new LayerZeroSetConfigParam[](0);
        AbstractLayerZeroV2HookIsm.RemoteRouterConfigUpdate[]
            memory updates = new AbstractLayerZeroV2HookIsm.RemoteRouterConfigUpdate[](
                2
            );
        updates[0] = AbstractLayerZeroV2HookIsm.RemoteRouterConfigUpdate({
            domain: DESTINATION,
            router: address(0x1234).addressToBytes32(),
            receiveLibraryTimeout: address(0),
            receiveLibraryTimeoutExpiry: 0,
            sendConfig: emptyConfig,
            receiveConfig: emptyConfig
        });
        updates[1] = AbstractLayerZeroV2HookIsm.RemoteRouterConfigUpdate({
            domain: SECOND_DESTINATION,
            router: address(0x5678).addressToBytes32(),
            receiveLibraryTimeout: address(0),
            receiveLibraryTimeoutExpiry: 0,
            sendConfig: emptyConfig,
            receiveConfig: emptyConfig
        });

        _updateVariants(originRouter, updates);
        assertEq(
            originRouter.routers(DESTINATION),
            address(0x1234).addressToBytes32()
        );
        assertEq(
            originRouter.routers(SECOND_DESTINATION),
            address(0x5678).addressToBytes32()
        );
    }

    function testBatchConfigUpdateRollsBackTogether() public {
        _configure(
            originRouter,
            originEndpoint,
            originUln,
            SECOND_DESTINATION,
            SECOND_DESTINATION_EID,
            address(0xABCD)
        );
        bytes32 currentRouter = originRouter.routers(DESTINATION);
        bytes32 secondCurrentRouter = originRouter.routers(SECOND_DESTINATION);
        LayerZeroSetConfigParam[]
            memory emptyConfig = new LayerZeroSetConfigParam[](0);
        AbstractLayerZeroV2HookIsm.RemoteRouterConfigUpdate[]
            memory updates = new AbstractLayerZeroV2HookIsm.RemoteRouterConfigUpdate[](
                2
            );
        updates[0] = AbstractLayerZeroV2HookIsm.RemoteRouterConfigUpdate({
            domain: DESTINATION,
            router: address(0x1234).addressToBytes32(),
            receiveLibraryTimeout: address(0),
            receiveLibraryTimeoutExpiry: 0,
            sendConfig: emptyConfig,
            receiveConfig: emptyConfig
        });
        updates[1] = AbstractLayerZeroV2HookIsm.RemoteRouterConfigUpdate({
            domain: SECOND_DESTINATION,
            router: bytes32(0),
            receiveLibraryTimeout: address(0),
            receiveLibraryTimeoutExpiry: 0,
            sendConfig: emptyConfig,
            receiveConfig: emptyConfig
        });

        vm.expectRevert(
            abi.encodeWithSelector(
                AbstractLayerZeroV2HookIsm.NonCanonicalLayerZeroPeer.selector,
                bytes32(0)
            )
        );
        _updateVariants(originRouter, updates);
        assertEq(originRouter.routers(DESTINATION), currentRouter);
        assertEq(originRouter.routers(SECOND_DESTINATION), secondCurrentRouter);
    }

    function testConfigurationIsOwnerGated() public {
        LayerZeroSetConfigParam[]
            memory emptyConfig = new LayerZeroSetConfigParam[](0);
        vm.prank(address(0xBEEF));
        vm.expectRevert("Ownable: caller is not the owner");
        _updateVariant(
            originRouter,
            AbstractLayerZeroV2HookIsm.RemoteRouterConfigUpdate({
                domain: DESTINATION,
                router: address(destinationRouter).addressToBytes32(),
                receiveLibraryTimeout: address(0),
                receiveLibraryTimeoutExpiry: 0,
                sendConfig: emptyConfig,
                receiveConfig: emptyConfig
            })
        );
    }

    function testAtomicEnrollmentRollsBackIncompleteRoute() public {
        AbstractLayerZeroV2HookIsm router = _deploy(
            address(originMailbox),
            address(originEndpoint)
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                AbstractLayerZeroV2HookIsm
                    .UnregisteredLayerZeroLibrary
                    .selector,
                address(0)
            )
        );
        LayerZeroSetConfigParam[]
            memory emptyConfig = new LayerZeroSetConfigParam[](0);
        _enrollVariant(
            router,
            AbstractLayerZeroV2HookIsm.RemoteRouterEnrollment({
                domain: DESTINATION,
                router: address(destinationRouter).addressToBytes32(),
                eid: DESTINATION_EID,
                sendLibrary: address(0),
                receiveLibrary: address(originUln),
                receiveLibraryGracePeriod: 0,
                receiveLibraryTimeout: address(0),
                receiveLibraryTimeoutExpiry: 0,
                sendConfig: emptyConfig,
                receiveConfig: emptyConfig
            })
        );
        assertEq(router.routers(DESTINATION), bytes32(0));
    }

    function testQuoteAndDispatchPayLayerZeroFee() public {
        bytes memory message = originMailbox.buildOutboundMessage(
            DESTINATION,
            address(recipient).addressToBytes32(),
            bytes("quote")
        );
        assertEq(originRouter.quoteDispatch("", message), NATIVE_FEE);
        _dispatch();
        assertEq(address(originEndpoint).balance, NATIVE_FEE);
    }

    function testNextNonceSelectsUnorderedDelivery() public view {
        assertEq(originRouter.nextNonce(DESTINATION_EID, bytes32(0)), 0);
    }

    function testRuntimeCodeFitsEip170() public view {
        // Coverage instrumentation changes runtime bytecode and cannot measure
        // the deployable artifact's EIP-170 size. The default/CI profiles do.
        if (
            keccak256(bytes(vm.envOr("FOUNDRY_PROFILE", string("default")))) ==
            keccak256(bytes("coverage"))
        ) return;
        assertLe(address(originRouter).code.length, EIP_170_MAX_CODE_SIZE);
    }

    function testFuzzLayerZeroPayloadRoundTrip(
        uint32 origin,
        uint32 destination,
        bytes32 messageId
    ) public view {
        (
            uint32 decodedOrigin,
            uint32 decodedDestination,
            bytes32 decodedId
        ) = this.decodeLayerZeroPayload(
                LayerZeroMessage.encode(origin, destination, messageId)
            );
        assertEq(decodedOrigin, origin);
        assertEq(decodedDestination, destination);
        assertEq(decodedId, messageId);
    }

    function decodeLayerZeroPayload(
        bytes calldata payload
    ) external pure returns (uint32, uint32, bytes32) {
        return LayerZeroMessage.decode(payload);
    }

    function decodeLayerZeroPacket(
        bytes calldata packet
    ) external pure returns (uint64, bytes32, bytes32) {
        return (
            PacketV1Codec.nonce(packet),
            PacketV1Codec.guid(packet),
            PacketV1Codec.payloadHash(packet)
        );
    }
}

contract LayerZeroV2CallbackHookIsmTest is LayerZeroV2HookIsmTestBase {
    using TypeCasts for address;

    function _deploy(
        address mailbox,
        address endpoint
    ) internal override returns (AbstractLayerZeroV2HookIsm) {
        return new LayerZeroV2CallbackHookIsm(mailbox, endpoint);
    }

    function _enrollVariant(
        AbstractLayerZeroV2HookIsm router,
        AbstractLayerZeroV2HookIsm.RemoteRouterEnrollment memory enrollment
    ) internal override {
        LayerZeroV2CallbackHookIsm(address(router)).enrollLayerZeroRemoteRouter(
            enrollment,
            CALLBACK_GAS
        );
    }

    function _updateVariant(
        AbstractLayerZeroV2HookIsm router,
        AbstractLayerZeroV2HookIsm.RemoteRouterConfigUpdate memory update_
    ) internal override {
        LayerZeroV2CallbackHookIsm(address(router))
            .updateLayerZeroRemoteRouterConfig(update_, CALLBACK_GAS);
    }

    function _updateVariants(
        AbstractLayerZeroV2HookIsm router,
        AbstractLayerZeroV2HookIsm.RemoteRouterConfigUpdate[] memory updates
    ) internal override {
        uint128[] memory gasLimits = new uint128[](updates.length);
        for (uint256 i = 0; i < gasLimits.length; ++i) {
            gasLimits[i] = CALLBACK_GAS;
        }
        LayerZeroV2CallbackHookIsm(address(router))
            .updateLayerZeroRemoteRouterConfigs(updates, gasLimits);
    }

    function testAtomicEnrollmentRollsBackInvalidCallbackGas() public {
        LayerZeroV2CallbackHookIsm router = new LayerZeroV2CallbackHookIsm(
            address(originMailbox),
            address(originEndpoint)
        );
        LayerZeroSetConfigParam[]
            memory emptyConfig = new LayerZeroSetConfigParam[](0);
        AbstractLayerZeroV2HookIsm.RemoteRouterEnrollment
            memory enrollment = AbstractLayerZeroV2HookIsm
                .RemoteRouterEnrollment({
                    domain: DESTINATION,
                    router: address(destinationRouter).addressToBytes32(),
                    eid: DESTINATION_EID,
                    sendLibrary: address(originUln),
                    receiveLibrary: address(originUln),
                    receiveLibraryGracePeriod: 0,
                    receiveLibraryTimeout: address(0),
                    receiveLibraryTimeoutExpiry: 0,
                    sendConfig: emptyConfig,
                    receiveConfig: emptyConfig
                });

        vm.expectRevert(
            LayerZeroV2CallbackHookIsm.InvalidLayerZeroCallbackGasLimit.selector
        );
        router.enrollLayerZeroRemoteRouter(enrollment, 0);
        assertEq(router.routers(DESTINATION), bytes32(0));
        assertEq(
            originEndpoint.getSendLibrary(address(router), DESTINATION_EID),
            address(0)
        );
    }

    function testConfigOnlyUpdateChangesCallbackGasAtomically() public {
        LayerZeroSetConfigParam[]
            memory emptyConfig = new LayerZeroSetConfigParam[](0);
        LayerZeroV2CallbackHookIsm(address(originRouter))
            .updateLayerZeroRemoteRouterConfig(
                AbstractLayerZeroV2HookIsm.RemoteRouterConfigUpdate({
                    domain: DESTINATION,
                    router: address(destinationRouter).addressToBytes32(),
                    receiveLibraryTimeout: address(0),
                    receiveLibraryTimeoutExpiry: 0,
                    sendConfig: emptyConfig,
                    receiveConfig: emptyConfig
                }),
                275_000
            );
        assertEq(
            LayerZeroV2CallbackHookIsm(address(originRouter)).callbackGasLimits(
                DESTINATION
            ),
            275_000
        );
    }

    function testBatchConfigUpdateRejectsGasLengthMismatch() public {
        AbstractLayerZeroV2HookIsm.RemoteRouterConfigUpdate[]
            memory updates = new AbstractLayerZeroV2HookIsm.RemoteRouterConfigUpdate[](
                1
            );
        uint128[] memory gasLimits = new uint128[](0);
        vm.expectRevert(
            LayerZeroV2CallbackHookIsm.LayerZeroConfigLengthMismatch.selector
        );
        LayerZeroV2CallbackHookIsm(address(originRouter))
            .updateLayerZeroRemoteRouterConfigs(updates, gasLimits);
    }

    function testBatchEnrollmentConfiguresEveryCallbackRoute() public {
        LayerZeroSetConfigParam[]
            memory emptyConfig = new LayerZeroSetConfigParam[](0);
        AbstractLayerZeroV2HookIsm.RemoteRouterEnrollment[]
            memory enrollments = new AbstractLayerZeroV2HookIsm.RemoteRouterEnrollment[](
                1
            );
        enrollments[0] = AbstractLayerZeroV2HookIsm.RemoteRouterEnrollment({
            domain: SECOND_DESTINATION,
            router: address(0xBEEF).addressToBytes32(),
            eid: SECOND_DESTINATION_EID,
            sendLibrary: address(originUln),
            receiveLibrary: address(originUln),
            receiveLibraryGracePeriod: 0,
            receiveLibraryTimeout: address(0),
            receiveLibraryTimeoutExpiry: 0,
            sendConfig: emptyConfig,
            receiveConfig: emptyConfig
        });
        uint128[] memory gasLimits = new uint128[](1);
        gasLimits[0] = CALLBACK_GAS + 1;

        LayerZeroV2CallbackHookIsm(address(originRouter))
            .enrollLayerZeroRemoteRouters(enrollments, gasLimits);
        assertEq(
            LayerZeroV2CallbackHookIsm(address(originRouter)).callbackGasLimits(
                SECOND_DESTINATION
            ),
            CALLBACK_GAS + 1
        );
    }

    function testCallbackAuthorizesAndMailboxProcesses() public {
        (bytes memory message, bytes32 messageId) = _dispatch();
        bytes memory payload = LayerZeroMessage.encode(
            ORIGIN,
            DESTINATION,
            messageId
        );
        bytes memory packet = originEndpoint.lastPacket();
        (uint64 packetNonce, bytes32 packetGuid, ) = this.decodeLayerZeroPacket(
            packet
        );
        LayerZeroOrigin memory origin = LayerZeroOrigin({
            srcEid: ORIGIN_EID,
            sender: address(originRouter).addressToBytes32(),
            nonce: packetNonce
        });
        destinationEndpoint.mockDeliver(
            address(destinationRouter),
            origin,
            packetGuid,
            payload
        );
        destinationMailbox.process("", message);
        assertEq(recipient.lastData(), bytes("hyperlane over layerzero"));
    }

    function testCallbackOptionsGoldenVector() public {
        _dispatch();
        assertEq(
            keccak256(originEndpoint.lastOptions()),
            keccak256(
                abi.encodePacked(
                    uint16(3),
                    uint8(1),
                    uint16(17),
                    uint8(1),
                    CALLBACK_GAS
                )
            )
        );
    }

    function testCallbackRejectsSpoofedEndpointAndGuid() public {
        (bytes memory message, bytes32 messageId) = _dispatch();
        bytes memory packet = originEndpoint.lastPacket();
        (uint64 packetNonce, bytes32 packetGuid, ) = this.decodeLayerZeroPacket(
            packet
        );
        LayerZeroOrigin memory origin = LayerZeroOrigin({
            srcEid: ORIGIN_EID,
            sender: address(originRouter).addressToBytes32(),
            nonce: packetNonce
        });
        bytes memory payload = LayerZeroMessage.encode(
            ORIGIN,
            DESTINATION,
            messageId
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                LayerZeroV2CallbackHookIsm
                    .UnauthorizedLayerZeroEndpoint
                    .selector,
                address(this)
            )
        );
        LayerZeroV2CallbackHookIsm(address(destinationRouter)).lzReceive(
            origin,
            packetGuid,
            payload,
            address(this),
            ""
        );

        bytes32 wrongGuid = bytes32(uint256(123));
        bytes32 expectedGuid = GUID.generate(
            origin.nonce,
            origin.srcEid,
            address(originRouter),
            DESTINATION_EID,
            address(destinationRouter).addressToBytes32()
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                LayerZeroV2CallbackHookIsm.WrongLayerZeroGuid.selector,
                wrongGuid,
                expectedGuid
            )
        );
        destinationEndpoint.mockDeliver(
            address(destinationRouter),
            origin,
            wrongGuid,
            payload
        );
        assertFalse(
            LayerZeroV2CallbackHookIsm(address(destinationRouter)).verify(
                "",
                message
            )
        );
    }

    function testCallbackRejectsValueAndInvalidRoutes() public {
        (bytes memory message, bytes32 messageId) = _dispatch();
        bytes memory packet = originEndpoint.lastPacket();
        (uint64 packetNonce, bytes32 packetGuid, ) = this.decodeLayerZeroPacket(
            packet
        );
        LayerZeroOrigin memory origin = LayerZeroOrigin({
            srcEid: ORIGIN_EID,
            sender: address(originRouter).addressToBytes32(),
            nonce: packetNonce
        });
        bytes memory payload = LayerZeroMessage.encode(
            ORIGIN,
            DESTINATION,
            messageId
        );

        vm.deal(address(destinationEndpoint), 1);
        vm.prank(address(destinationEndpoint));
        vm.expectRevert(
            abi.encodeWithSelector(
                LayerZeroV2CallbackHookIsm
                    .UnexpectedLayerZeroCallbackValue
                    .selector,
                1
            )
        );
        LayerZeroV2CallbackHookIsm(address(destinationRouter)).lzReceive{
            value: 1
        }(origin, packetGuid, payload, address(this), "");

        LayerZeroOrigin memory invalidOrigin = origin;
        invalidOrigin.srcEid = SECOND_DESTINATION_EID;
        vm.expectRevert(
            abi.encodeWithSelector(
                AbstractLayerZeroV2HookIsm.InvalidRemoteEid.selector,
                SECOND_DESTINATION_EID
            )
        );
        destinationEndpoint.mockDeliver(
            address(destinationRouter),
            invalidOrigin,
            packetGuid,
            payload
        );

        invalidOrigin = origin;
        invalidOrigin.srcEid = ORIGIN_EID;
        invalidOrigin.sender = address(0xBEEF).addressToBytes32();
        vm.expectRevert(
            abi.encodeWithSelector(
                AbstractLayerZeroV2HookIsm.NonCanonicalLayerZeroPeer.selector,
                invalidOrigin.sender
            )
        );
        destinationEndpoint.mockDeliver(
            address(destinationRouter),
            invalidOrigin,
            packetGuid,
            payload
        );
    }

    function testCallbackRejectsWrongPayloadDomains() public {
        (, bytes32 messageId) = _dispatch();
        bytes memory packet = originEndpoint.lastPacket();
        (uint64 packetNonce, bytes32 packetGuid, ) = this.decodeLayerZeroPacket(
            packet
        );
        LayerZeroOrigin memory origin = LayerZeroOrigin({
            srcEid: ORIGIN_EID,
            sender: address(originRouter).addressToBytes32(),
            nonce: packetNonce
        });

        vm.expectRevert(
            abi.encodeWithSelector(
                LayerZeroV2CallbackHookIsm.WrongLayerZeroPayloadOrigin.selector,
                SECOND_DESTINATION,
                ORIGIN
            )
        );
        destinationEndpoint.mockDeliver(
            address(destinationRouter),
            origin,
            packetGuid,
            LayerZeroMessage.encode(SECOND_DESTINATION, DESTINATION, messageId)
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                LayerZeroV2CallbackHookIsm
                    .WrongLayerZeroPayloadDestination
                    .selector,
                SECOND_DESTINATION,
                DESTINATION
            )
        );
        destinationEndpoint.mockDeliver(
            address(destinationRouter),
            origin,
            packetGuid,
            LayerZeroMessage.encode(ORIGIN, SECOND_DESTINATION, messageId)
        );
    }

    function testCallbackIsIdempotentAndRejectsConflictingOrigin() public {
        (bytes memory message, bytes32 messageId) = _dispatch();
        bytes memory packet = originEndpoint.lastPacket();
        (uint64 packetNonce, bytes32 packetGuid, ) = this.decodeLayerZeroPacket(
            packet
        );
        LayerZeroOrigin memory origin = LayerZeroOrigin({
            srcEid: ORIGIN_EID,
            sender: address(originRouter).addressToBytes32(),
            nonce: packetNonce
        });
        bytes memory payload = LayerZeroMessage.encode(
            ORIGIN,
            DESTINATION,
            messageId
        );
        destinationEndpoint.mockDeliver(
            address(destinationRouter),
            origin,
            packetGuid,
            payload
        );
        destinationEndpoint.mockDeliver(
            address(destinationRouter),
            origin,
            packetGuid,
            payload
        );

        _configure(
            destinationRouter,
            destinationEndpoint,
            destinationUln,
            SECOND_DESTINATION,
            SECOND_DESTINATION_EID,
            address(0xBEEF)
        );
        LayerZeroOrigin memory conflictingOrigin = LayerZeroOrigin({
            srcEid: SECOND_DESTINATION_EID,
            sender: address(0xBEEF).addressToBytes32(),
            nonce: 7
        });
        bytes32 conflictingGuid = GUID.generate(
            conflictingOrigin.nonce,
            conflictingOrigin.srcEid,
            address(0xBEEF),
            DESTINATION_EID,
            address(destinationRouter).addressToBytes32()
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                LayerZeroV2CallbackHookIsm
                    .ConflictingLayerZeroAuthorization
                    .selector,
                messageId
            )
        );
        destinationEndpoint.mockDeliver(
            address(destinationRouter),
            conflictingOrigin,
            conflictingGuid,
            LayerZeroMessage.encode(SECOND_DESTINATION, DESTINATION, messageId)
        );

        vm.expectRevert(
            LayerZeroV2CallbackHookIsm.UnexpectedHyperlaneMetadata.selector
        );
        LayerZeroV2CallbackHookIsm(address(destinationRouter)).verify(
            hex"01",
            message
        );
        bytes memory wrongDestination = originMailbox.buildOutboundMessage(
            SECOND_DESTINATION,
            address(recipient).addressToBytes32(),
            "wrong destination"
        );
        assertFalse(
            LayerZeroV2CallbackHookIsm(address(destinationRouter)).verify(
                "",
                wrongDestination
            )
        );
    }
}

contract LayerZeroV2CcipReadHookIsmTest is LayerZeroV2HookIsmTestBase {
    using TypeCasts for address;

    string[] internal lookupUrls;

    function setUp() public override {
        lookupUrls.push("http://localhost:3000/layerzero");
        super.setUp();
    }

    function _deploy(
        address mailbox,
        address endpoint
    ) internal override returns (AbstractLayerZeroV2HookIsm) {
        return new LayerZeroV2CcipReadHookIsm(mailbox, endpoint, lookupUrls);
    }

    function _enrollVariant(
        AbstractLayerZeroV2HookIsm router,
        AbstractLayerZeroV2HookIsm.RemoteRouterEnrollment memory enrollment
    ) internal override {
        LayerZeroV2CcipReadHookIsm(address(router)).enrollLayerZeroRemoteRouter(
            enrollment
        );
    }

    function _updateVariant(
        AbstractLayerZeroV2HookIsm router,
        AbstractLayerZeroV2HookIsm.RemoteRouterConfigUpdate memory update_
    ) internal override {
        LayerZeroV2CcipReadHookIsm(address(router))
            .updateLayerZeroRemoteRouterConfig(update_);
    }

    function _updateVariants(
        AbstractLayerZeroV2HookIsm router,
        AbstractLayerZeroV2HookIsm.RemoteRouterConfigUpdate[] memory updates
    ) internal override {
        LayerZeroV2CcipReadHookIsm(address(router))
            .updateLayerZeroRemoteRouterConfigs(updates);
    }

    function _replace(
        bytes memory value,
        uint256 offset,
        bytes memory replacement
    ) internal pure returns (bytes memory result) {
        result = bytes.concat(value);
        for (uint256 i = 0; i < replacement.length; ++i) {
            result[offset + i] = replacement[i];
        }
    }

    function _revertSelector(
        bytes memory returnData
    ) internal pure returns (bytes4 selector) {
        assembly {
            selector := mload(add(returnData, 0x20))
        }
    }

    function _expectPacketRevert(
        bytes memory message,
        bytes memory packet,
        bytes4 selector
    ) internal {
        (bool success, bytes memory returnData) = address(destinationMailbox)
            .call(
                abi.encodeCall(
                    destinationMailbox.process,
                    (abi.encode(address(destinationUln), packet), message)
                )
            );
        assertFalse(success);
        assertEq(
            _revertSelector(returnData),
            selector,
            "unexpected packet validation error"
        );
    }

    function testPullCommitsClearsAndProcessesAtomically() public {
        (bytes memory message, ) = _dispatch();
        bytes memory metadata = abi.encode(
            address(destinationUln),
            originEndpoint.lastPacket()
        );
        destinationMailbox.process(metadata, message);
        assertEq(recipient.lastData(), bytes("hyperlane over layerzero"));
        assertEq(
            destinationEndpoint.inboundPayloadHash(
                address(destinationRouter),
                ORIGIN_EID,
                address(originRouter).addressToBytes32(),
                1
            ),
            bytes32(0)
        );
    }

    function testPullOptionsGoldenVector() public {
        _dispatch();
        assertEq(
            keccak256(originEndpoint.lastOptions()),
            keccak256(
                abi.encodePacked(
                    uint16(3),
                    uint8(1),
                    uint16(17),
                    uint8(1),
                    uint128(1)
                )
            )
        );
    }

    function testPullRejectsCallbackDelivery() public {
        vm.expectRevert(
            LayerZeroV2CcipReadHookIsm.PullLayerZeroCallbackUnsupported.selector
        );
        LayerZeroV2CcipReadHookIsm(address(destinationRouter)).lzReceive(
            LayerZeroOrigin({srcEid: ORIGIN_EID, sender: bytes32(0), nonce: 1}),
            bytes32(0),
            "",
            address(this),
            ""
        );
    }

    function testPullRejectsDirectVerify() public {
        (bytes memory message, ) = _dispatch();
        bytes memory metadata = abi.encode(
            address(destinationUln),
            originEndpoint.lastPacket()
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                LayerZeroV2CcipReadHookIsm.UnauthorizedMailboxCaller.selector,
                address(this)
            )
        );
        LayerZeroV2CcipReadHookIsm(address(destinationRouter)).verify(
            metadata,
            message
        );
    }

    function testPullRollbackWhenRecipientReverts() public {
        (bytes memory message, ) = _dispatch();
        bytes memory metadata = abi.encode(
            address(destinationUln),
            originEndpoint.lastPacket()
        );
        recipient.setInterchainSecurityModule(address(destinationRouter));
        vm.mockCallRevert(
            address(recipient),
            abi.encodeWithSelector(recipient.handle.selector),
            bytes("recipient reverted")
        );
        vm.expectRevert(bytes("recipient reverted"));
        destinationMailbox.process(metadata, message);
        assertEq(
            destinationEndpoint.inboundPayloadHash(
                address(destinationRouter),
                ORIGIN_EID,
                address(originRouter).addressToBytes32(),
                1
            ),
            bytes32(0)
        );
    }

    function testPullRejectsPendingDvnsAndConflictingPayload() public {
        (bytes memory message, ) = _dispatch();
        bytes memory packet = originEndpoint.lastPacket();
        (uint64 packetNonce, , bytes32 packetPayloadHash) = this
            .decodeLayerZeroPacket(packet);
        bytes memory metadata = abi.encode(address(destinationUln), packet);
        destinationUln.setReady(false);
        vm.expectRevert(bytes("DVNs pending"));
        destinationMailbox.process(metadata, message);

        destinationUln.setReady(true);
        vm.prank(address(destinationUln));
        destinationEndpoint.mockVerify(
            address(destinationRouter),
            ORIGIN_EID,
            address(originRouter).addressToBytes32(),
            packetNonce,
            bytes32(uint256(1))
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                LayerZeroV2CcipReadHookIsm.ConflictingPayloadHash.selector,
                bytes32(uint256(1)),
                packetPayloadHash
            )
        );
        destinationMailbox.process(metadata, message);
    }

    function testPullRejectsNonCanonicalMetadata() public {
        (bytes memory message, ) = _dispatch();
        bytes memory metadata = bytes.concat(
            abi.encode(address(destinationUln), originEndpoint.lastPacket()),
            hex"00"
        );
        vm.expectRevert(LayerZeroMetadata.InvalidLayerZeroMetadata.selector);
        destinationMailbox.process(metadata, message);
    }

    function testPullBatchEnrollmentAndOffchainLookup() public {
        LayerZeroSetConfigParam[]
            memory emptyConfig = new LayerZeroSetConfigParam[](0);
        AbstractLayerZeroV2HookIsm.RemoteRouterEnrollment[]
            memory enrollments = new AbstractLayerZeroV2HookIsm.RemoteRouterEnrollment[](
                1
            );
        enrollments[0] = AbstractLayerZeroV2HookIsm.RemoteRouterEnrollment({
            domain: SECOND_DESTINATION,
            router: address(0xBEEF).addressToBytes32(),
            eid: SECOND_DESTINATION_EID,
            sendLibrary: address(originUln),
            receiveLibrary: address(originUln),
            receiveLibraryGracePeriod: 0,
            receiveLibraryTimeout: address(0),
            receiveLibraryTimeoutExpiry: 0,
            sendConfig: emptyConfig,
            receiveConfig: emptyConfig
        });
        LayerZeroV2CcipReadHookIsm(address(originRouter))
            .enrollLayerZeroRemoteRouters(enrollments);
        assertEq(
            originRouter.routers(SECOND_DESTINATION),
            address(0xBEEF).addressToBytes32()
        );

        bytes memory message = originMailbox.buildOutboundMessage(
            DESTINATION,
            address(recipient).addressToBytes32(),
            "lookup"
        );
        (bool success, bytes memory returnData) = address(destinationRouter)
            .staticcall(
                abi.encodeCall(ICcipReadIsm.getOffchainVerifyInfo, (message))
            );
        assertFalse(success);
        assertEq(
            _revertSelector(returnData),
            ICcipReadIsm.OffchainLookup.selector
        );
    }

    function testPullRejectsEveryInvalidPacketField() public {
        (bytes memory message, ) = _dispatch();
        bytes memory packet = originEndpoint.lastPacket();

        _expectPacketRevert(
            message,
            bytes.concat(packet, hex"00"),
            LayerZeroV2CcipReadHookIsm.InvalidLayerZeroPacketLength.selector
        );
        _expectPacketRevert(
            message,
            _replace(packet, 0, abi.encodePacked(uint8(2))),
            LayerZeroV2CcipReadHookIsm.InvalidLayerZeroPacketVersion.selector
        );
        _expectPacketRevert(
            message,
            _replace(packet, 9, abi.encodePacked(uint32(123))),
            LayerZeroV2CcipReadHookIsm.WrongPacketSourceEid.selector
        );
        _expectPacketRevert(
            message,
            _replace(
                packet,
                13,
                abi.encodePacked(address(0xBEEF).addressToBytes32())
            ),
            LayerZeroV2CcipReadHookIsm.WrongPacketSender.selector
        );
        _expectPacketRevert(
            message,
            _replace(packet, 45, abi.encodePacked(uint32(123))),
            LayerZeroV2CcipReadHookIsm.WrongPacketDestinationEid.selector
        );
        _expectPacketRevert(
            message,
            _replace(
                packet,
                49,
                abi.encodePacked(address(0xBEEF).addressToBytes32())
            ),
            LayerZeroV2CcipReadHookIsm.WrongPacketReceiver.selector
        );
        _expectPacketRevert(
            message,
            _replace(packet, 113, abi.encodePacked(uint8(2))),
            LayerZeroV2CcipReadHookIsm.WrongPacketMessage.selector
        );
        _expectPacketRevert(
            message,
            _replace(packet, 81, abi.encodePacked(bytes32(uint256(123)))),
            LayerZeroV2CcipReadHookIsm.WrongPacketGuid.selector
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                LayerZeroV2CcipReadHookIsm.InvalidReceiveLibrary.selector,
                address(0xBEEF)
            )
        );
        destinationMailbox.process(
            abi.encode(address(0xBEEF), packet),
            message
        );
    }

    function testPullRejectsOversizedPacketMetadata() public {
        (bytes memory message, ) = _dispatch();
        vm.expectRevert(
            abi.encodeWithSelector(
                LayerZeroMetadata.LayerZeroPacketTooLarge.selector,
                4097
            )
        );
        destinationMailbox.process(
            abi.encode(address(destinationUln), new bytes(4097)),
            message
        );
    }

    function testPullRejectsVerifyOutsideMailboxProcessing() public {
        (bytes memory message, bytes32 messageId) = _dispatch();
        bytes memory metadata = abi.encode(
            address(destinationUln),
            originEndpoint.lastPacket()
        );
        vm.prank(address(destinationMailbox));
        vm.expectRevert(
            abi.encodeWithSelector(
                LayerZeroV2CcipReadHookIsm.MessageNotBeingProcessed.selector,
                messageId
            )
        );
        LayerZeroV2CcipReadHookIsm(address(destinationRouter)).verify(
            metadata,
            message
        );
    }
}
