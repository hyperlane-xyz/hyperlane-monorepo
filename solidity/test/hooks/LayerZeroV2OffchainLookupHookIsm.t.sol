// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {Origin as LayerZeroOrigin} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {IMessageLibManager, SetConfigParam as LayerZeroSetConfigParam} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/IMessageLibManager.sol";
import {GUID} from "@layerzerolabs/lz-evm-protocol-v2/contracts/libs/GUID.sol";
import {PacketV1Codec} from "@layerzerolabs/lz-evm-protocol-v2/contracts/messagelib/libs/PacketV1Codec.sol";
import {UlnConfig} from "@layerzerolabs/lz-evm-messagelib-v2/contracts/uln/UlnBase.sol";
import {LayerZeroV2OffchainLookupHookIsm} from "contracts/hooks/layerzero/LayerZeroV2OffchainLookupHookIsm.sol";
import {LayerZeroConfigTypeLib} from "contracts/hooks/layerzero/libs/LayerZeroConfigType.sol";
import {IInterchainSecurityModule} from "contracts/interfaces/IInterchainSecurityModule.sol";
import {IPostDispatchHook} from "contracts/interfaces/hooks/IPostDispatchHook.sol";
import {ICcipReadIsm} from "contracts/interfaces/isms/ICcipReadIsm.sol";
import {StaticAggregationIsmFactory} from "contracts/isms/aggregation/StaticAggregationIsmFactory.sol";
import {DomainRoutingIsm} from "contracts/isms/routing/DomainRoutingIsm.sol";
import {LayerZeroMessage} from "contracts/libs/LayerZeroMessage.sol";
import {LayerZeroMetadata} from "contracts/libs/LayerZeroMetadata.sol";
import {Message} from "contracts/libs/Message.sol";
import {TypeCasts} from "contracts/libs/TypeCasts.sol";
import {StandardHookMetadata} from "contracts/hooks/libs/StandardHookMetadata.sol";
import {MockLayerZeroEndpointV2} from "contracts/mock/MockLayerZeroEndpointV2.sol";
import {MockLayerZeroReceiveUln} from "contracts/mock/MockLayerZeroReceiveUln.sol";
import {TestMailbox} from "contracts/test/TestMailbox.sol";
import {TestIsm} from "contracts/test/TestIsm.sol";
import {TestPostDispatchHook} from "contracts/test/TestPostDispatchHook.sol";
import {TestRecipient} from "contracts/test/TestRecipient.sol";

contract LayerZeroV2OffchainLookupHookIsmTest is Test {
    using Message for bytes;
    using TypeCasts for address;

    uint32 internal constant ORIGIN = 1000;
    uint32 internal constant DESTINATION = 2000;
    uint32 internal constant SECOND_DESTINATION = 2001;
    uint32 internal constant ORIGIN_ENDPOINT_ID = 30101;
    uint32 internal constant DESTINATION_ENDPOINT_ID = 30111;
    uint32 internal constant SECOND_DESTINATION_ENDPOINT_ID = 30112;
    uint256 internal constant NATIVE_FEE = 0.01 ether;
    uint256 internal constant EIP_170_MAX_CODE_SIZE = 24_576;
    uint256 internal constant PROCESS_GAS_LIMIT = 350_000;

    TestMailbox internal originMailbox;
    TestMailbox internal destinationMailbox;
    MockLayerZeroEndpointV2 internal originEndpoint;
    MockLayerZeroEndpointV2 internal destinationEndpoint;
    MockLayerZeroReceiveUln internal originUln;
    MockLayerZeroReceiveUln internal destinationUln;
    TestPostDispatchHook internal noopHook;
    TestRecipient internal recipient;
    LayerZeroV2OffchainLookupHookIsm internal originRouter;
    LayerZeroV2OffchainLookupHookIsm internal destinationRouter;
    string[] internal lookupUrls;

    function setUp() public {
        lookupUrls.push("http://localhost:3000/layerzero");
        originMailbox = new TestMailbox(ORIGIN);
        destinationMailbox = new TestMailbox(DESTINATION);
        originEndpoint = new MockLayerZeroEndpointV2(ORIGIN_ENDPOINT_ID);
        destinationEndpoint = new MockLayerZeroEndpointV2(
            DESTINATION_ENDPOINT_ID
        );
        originUln = new MockLayerZeroReceiveUln(address(originEndpoint));
        destinationUln = new MockLayerZeroReceiveUln(
            address(destinationEndpoint)
        );
        originEndpoint.registerMockLibrary(address(originUln));
        destinationEndpoint.registerMockLibrary(address(destinationUln));
        originEndpoint.setDefaultReceiveLibrary(
            DESTINATION_ENDPOINT_ID,
            address(originUln)
        );
        destinationEndpoint.setDefaultReceiveLibrary(
            ORIGIN_ENDPOINT_ID,
            address(destinationUln)
        );
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
            originUln,
            DESTINATION,
            DESTINATION_ENDPOINT_ID,
            address(destinationRouter)
        );
        _configure(
            destinationRouter,
            destinationUln,
            ORIGIN,
            ORIGIN_ENDPOINT_ID,
            address(originRouter)
        );
        recipient.setInterchainSecurityModule(address(destinationRouter));
        vm.deal(address(this), 10 ether);
    }

    function _deploy(
        address mailbox,
        address endpoint
    ) internal returns (LayerZeroV2OffchainLookupHookIsm) {
        return
            new LayerZeroV2OffchainLookupHookIsm(mailbox, endpoint, lookupUrls);
    }

    function _configure(
        LayerZeroV2OffchainLookupHookIsm router,
        MockLayerZeroReceiveUln uln,
        uint32 domain,
        uint32 endpointId,
        address remote
    ) internal {
        LayerZeroSetConfigParam[]
            memory emptyConfig = new LayerZeroSetConfigParam[](0);
        router.enrollLayerZeroRemoteRouter(
            LayerZeroV2OffchainLookupHookIsm.RemoteRouterConfig({
                domainId: domain,
                domainIsm: remote.addressToBytes32(),
                endpointId: endpointId,
                sendLibrary: address(uln),
                receiveLibrary: address(uln),
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

    function _defaultRemoteRouterConfig()
        internal
        view
        returns (LayerZeroV2OffchainLookupHookIsm.RemoteRouterConfig memory)
    {
        LayerZeroSetConfigParam[]
            memory emptyConfig = new LayerZeroSetConfigParam[](0);
        return
            LayerZeroV2OffchainLookupHookIsm.RemoteRouterConfig({
                domainId: DESTINATION,
                domainIsm: address(destinationRouter).addressToBytes32(),
                endpointId: DESTINATION_ENDPOINT_ID,
                sendLibrary: address(originUln),
                receiveLibrary: address(originUln),
                sendConfig: emptyConfig,
                receiveConfig: emptyConfig
            });
    }

    function testLayerZeroConfigTypeTags() public {
        assertFalse(LayerZeroConfigTypeLib.isValid(0));
        assertTrue(
            LayerZeroConfigTypeLib.isValid(LayerZeroConfigTypeLib.EXECUTOR)
        );
        assertTrue(LayerZeroConfigTypeLib.isValid(LayerZeroConfigTypeLib.ULN));
        assertFalse(LayerZeroConfigTypeLib.isValid(3));
    }

    function testConstructorRejectsInvalidEndpoints() public {
        vm.expectRevert(
            LayerZeroV2OffchainLookupHookIsm.InvalidLayerZeroEndpoint.selector
        );
        _deploy(address(originMailbox), address(0));

        MockLayerZeroEndpointV2 zeroIdEndpoint = new MockLayerZeroEndpointV2(0);
        vm.expectRevert(
            LayerZeroV2OffchainLookupHookIsm.InvalidLocalEndpointId.selector
        );
        _deploy(address(originMailbox), address(zeroIdEndpoint));

        MockLayerZeroEndpointV2 tokenEndpoint = new MockLayerZeroEndpointV2(
            ORIGIN_ENDPOINT_ID
        );
        tokenEndpoint.setNativeToken(address(0xBEEF));
        vm.expectRevert(
            abi.encodeWithSelector(
                LayerZeroV2OffchainLookupHookIsm
                    .UnsupportedNativeTokenEndpoint
                    .selector,
                address(0xBEEF)
            )
        );
        _deploy(address(originMailbox), address(tokenEndpoint));
    }

    function testHookTypeAndPathInitialization() public view {
        assertEq(uint8(IPostDispatchHook.HookTypes.WORMHOLE), 18);
        assertEq(uint8(IPostDispatchHook.HookTypes.LAYER_ZERO), 19);
        assertEq(
            originRouter.hookType(),
            uint8(IPostDispatchHook.HookTypes.LAYER_ZERO)
        );
        assertTrue(
            originRouter.allowInitializePath(
                LayerZeroOrigin({
                    srcEid: DESTINATION_ENDPOINT_ID,
                    sender: address(destinationRouter).addressToBytes32(),
                    nonce: 1
                })
            )
        );
        assertFalse(
            originRouter.allowInitializePath(
                LayerZeroOrigin({
                    srcEid: DESTINATION_ENDPOINT_ID,
                    sender: address(0xBEEF).addressToBytes32(),
                    nonce: 1
                })
            )
        );
        assertFalse(
            originRouter.allowInitializePath(
                LayerZeroOrigin({
                    srcEid: SECOND_DESTINATION_ENDPOINT_ID,
                    sender: bytes32(0),
                    nonce: 1
                })
            )
        );
    }

    function testRejectsPartialEnrollmentAndUnsupportedHandle() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                LayerZeroV2OffchainLookupHookIsm
                    .IncompleteLayerZeroRoute
                    .selector,
                SECOND_DESTINATION
            )
        );
        originRouter.enrollRemoteRouter(
            SECOND_DESTINATION,
            address(0xBEEF).addressToBytes32()
        );

        vm.prank(address(originMailbox));
        vm.expectRevert(
            LayerZeroV2OffchainLookupHookIsm.HyperlaneHandleUnsupported.selector
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
        uint32 endpointId = originRouter.remoteLzEndpointIds(DESTINATION);
        assertEq(endpointId, 0);
        (bool enrolled, uint32 domainId) = originRouter.remoteLzEndpoints(
            DESTINATION_ENDPOINT_ID
        );
        assertFalse(enrolled);
        assertEq(domainId, 0);

        vm.expectRevert(
            abi.encodeWithSelector(
                LayerZeroV2OffchainLookupHookIsm.UnknownLayerZeroRoute.selector,
                DESTINATION
            )
        );
        originRouter.unenrollRemoteRouter(DESTINATION);
    }

    function testUnenrollClearsEndpointPolicyAndReenrollmentStartsClean()
        public
    {
        LayerZeroV2OffchainLookupHookIsm.RemoteRouterConfig
            memory config = _defaultRemoteRouterConfig();
        config.sendConfig = new LayerZeroSetConfigParam[](1);
        config.sendConfig[0] = LayerZeroSetConfigParam({
            eid: DESTINATION_ENDPOINT_ID,
            configType: 1,
            config: hex"1234"
        });
        config.receiveConfig = new LayerZeroSetConfigParam[](1);
        config.receiveConfig[0] = LayerZeroSetConfigParam({
            eid: DESTINATION_ENDPOINT_ID,
            configType: 2,
            config: hex"abcd"
        });
        originRouter.unenrollRemoteRouter(DESTINATION);
        originRouter.enrollLayerZeroRemoteRouter(config);

        originRouter.unenrollRemoteRouter(DESTINATION);
        address blockedLibrary = originEndpoint.blockedLibrary();
        assertEq(
            originEndpoint.getSendLibrary(
                address(originRouter),
                DESTINATION_ENDPOINT_ID
            ),
            blockedLibrary
        );
        (address receiveLibrary, ) = originEndpoint.getReceiveLibrary(
            address(originRouter),
            DESTINATION_ENDPOINT_ID
        );
        assertEq(receiveLibrary, blockedLibrary);
        (, uint256 expiry) = originEndpoint.receiveLibraryTimeout(
            address(originRouter),
            DESTINATION_ENDPOINT_ID
        );
        assertEq(expiry, 0);
        assertEq(
            originEndpoint.getConfig(
                address(originRouter),
                address(originUln),
                DESTINATION_ENDPOINT_ID,
                1
            ),
            abi.encode(uint32(0), address(0))
        );
        bytes memory defaultUlnConfig = abi.encode(
            UlnConfig({
                confirmations: 0,
                requiredDVNCount: 0,
                optionalDVNCount: 0,
                optionalDVNThreshold: 0,
                requiredDVNs: new address[](0),
                optionalDVNs: new address[](0)
            })
        );
        assertEq(
            originEndpoint.getConfig(
                address(originRouter),
                address(originUln),
                DESTINATION_ENDPOINT_ID,
                2
            ),
            defaultUlnConfig
        );

        config.sendConfig = new LayerZeroSetConfigParam[](0);
        config.receiveConfig = new LayerZeroSetConfigParam[](0);
        originRouter.enrollLayerZeroRemoteRouter(config);
        assertEq(
            originEndpoint.getSendLibrary(
                address(originRouter),
                DESTINATION_ENDPOINT_ID
            ),
            address(originUln)
        );
        assertEq(
            originEndpoint.getConfig(
                address(originRouter),
                address(originUln),
                DESTINATION_ENDPOINT_ID,
                2
            ),
            defaultUlnConfig
        );
    }

    function testUnenrollmentRollsBackIfEndpointCleanupFails() public {
        bytes32 currentRouter = originRouter.routers(DESTINATION);
        vm.mockCallRevert(
            address(originEndpoint),
            abi.encodeWithSelector(IMessageLibManager.setConfig.selector),
            abi.encodeWithSelector(
                MockLayerZeroEndpointV2.Unauthorized.selector
            )
        );
        vm.expectRevert(MockLayerZeroEndpointV2.Unauthorized.selector);
        originRouter.unenrollRemoteRouter(DESTINATION);

        assertEq(originRouter.routers(DESTINATION), currentRouter);
        assertEq(
            originRouter.remoteLzEndpointIds(DESTINATION),
            DESTINATION_ENDPOINT_ID
        );
    }

    function testEnrollmentOverwritesPeerAtomically() public {
        LayerZeroV2OffchainLookupHookIsm.RemoteRouterConfig
            memory config = _defaultRemoteRouterConfig();
        config.domainIsm = address(0x1234).addressToBytes32();
        originRouter.enrollLayerZeroRemoteRouter(config);
        assertEq(originRouter.routers(DESTINATION), config.domainIsm);
        assertEq(
            originRouter.remoteLzEndpointIds(DESTINATION),
            DESTINATION_ENDPOINT_ID
        );
    }

    function testOverwriteWithOmittedConfigRestoresDefaults() public {
        LayerZeroV2OffchainLookupHookIsm.RemoteRouterConfig
            memory config = _defaultRemoteRouterConfig();
        config.sendConfig = new LayerZeroSetConfigParam[](1);
        config.sendConfig[0] = LayerZeroSetConfigParam({
            eid: DESTINATION_ENDPOINT_ID,
            configType: 1,
            config: hex"1234"
        });
        config.receiveConfig = new LayerZeroSetConfigParam[](1);
        config.receiveConfig[0] = LayerZeroSetConfigParam({
            eid: DESTINATION_ENDPOINT_ID,
            configType: 2,
            config: hex"abcd"
        });
        originRouter.enrollLayerZeroRemoteRouter(config);

        config.sendConfig = new LayerZeroSetConfigParam[](0);
        config.receiveConfig = new LayerZeroSetConfigParam[](0);
        originRouter.enrollLayerZeroRemoteRouter(config);

        assertEq(
            originEndpoint.getConfig(
                address(originRouter),
                address(originUln),
                DESTINATION_ENDPOINT_ID,
                1
            ),
            abi.encode(uint32(0), address(0))
        );
        assertEq(
            originEndpoint.getConfig(
                address(originRouter),
                address(originUln),
                DESTINATION_ENDPOINT_ID,
                2
            ),
            abi.encode(
                UlnConfig({
                    confirmations: 0,
                    requiredDVNCount: 0,
                    optionalDVNCount: 0,
                    optionalDVNThreshold: 0,
                    requiredDVNs: new address[](0),
                    optionalDVNs: new address[](0)
                })
            )
        );
    }

    function testOverwriteBlocksOldEndpointWithoutResettingItsConfig() public {
        LayerZeroV2OffchainLookupHookIsm.RemoteRouterConfig
            memory config = _defaultRemoteRouterConfig();
        config.sendConfig = new LayerZeroSetConfigParam[](1);
        config.sendConfig[0] = LayerZeroSetConfigParam({
            eid: DESTINATION_ENDPOINT_ID,
            configType: 1,
            config: hex"1234"
        });
        originRouter.enrollLayerZeroRemoteRouter(config);

        config.endpointId = SECOND_DESTINATION_ENDPOINT_ID;
        config.sendConfig = new LayerZeroSetConfigParam[](0);
        originRouter.enrollLayerZeroRemoteRouter(config);

        assertEq(
            originEndpoint.getSendLibrary(
                address(originRouter),
                DESTINATION_ENDPOINT_ID
            ),
            originEndpoint.blockedLibrary()
        );
        (address oldReceiveLibrary, ) = originEndpoint.getReceiveLibrary(
            address(originRouter),
            DESTINATION_ENDPOINT_ID
        );
        assertEq(oldReceiveLibrary, originEndpoint.blockedLibrary());
        (bool oldEndpointEnrolled, ) = originRouter.remoteLzEndpoints(
            DESTINATION_ENDPOINT_ID
        );
        assertFalse(oldEndpointEnrolled);
        assertEq(
            originRouter.remoteLzEndpointIds(DESTINATION),
            SECOND_DESTINATION_ENDPOINT_ID
        );
        assertEq(
            originEndpoint.getConfig(
                address(originRouter),
                address(originUln),
                DESTINATION_ENDPOINT_ID,
                1
            ),
            hex"1234"
        );
    }

    function testOverwriteRollsBackIfOldEndpointBlockingFails() public {
        bytes32 currentPeer = originRouter.routers(DESTINATION);
        LayerZeroV2OffchainLookupHookIsm.RemoteRouterConfig
            memory config = _defaultRemoteRouterConfig();
        config.domainIsm = address(0x1234).addressToBytes32();
        config.endpointId = SECOND_DESTINATION_ENDPOINT_ID;
        vm.mockCallRevert(
            address(originEndpoint),
            abi.encodeWithSelector(
                IMessageLibManager.setReceiveLibrary.selector,
                address(originRouter),
                DESTINATION_ENDPOINT_ID,
                originEndpoint.blockedLibrary(),
                uint256(0)
            ),
            abi.encodeWithSelector(
                MockLayerZeroEndpointV2.Unauthorized.selector
            )
        );
        vm.expectRevert(MockLayerZeroEndpointV2.Unauthorized.selector);
        originRouter.enrollLayerZeroRemoteRouter(config);

        assertEq(originRouter.routers(DESTINATION), currentPeer);
        assertEq(
            originRouter.remoteLzEndpointIds(DESTINATION),
            DESTINATION_ENDPOINT_ID
        );
        (bool oldEndpointEnrolled, uint32 oldDomainId) = originRouter
            .remoteLzEndpoints(DESTINATION_ENDPOINT_ID);
        assertTrue(oldEndpointEnrolled);
        assertEq(oldDomainId, DESTINATION);
        (bool newEndpointEnrolled, ) = originRouter.remoteLzEndpoints(
            SECOND_DESTINATION_ENDPOINT_ID
        );
        assertFalse(newEndpointEnrolled);
        assertEq(
            originEndpoint.sendLibraries(
                address(originRouter),
                DESTINATION_ENDPOINT_ID
            ),
            address(originUln)
        );
        assertEq(
            originEndpoint.receiveLibraries(
                address(originRouter),
                DESTINATION_ENDPOINT_ID
            ),
            address(originUln)
        );
        assertEq(
            originEndpoint.sendLibraries(
                address(originRouter),
                SECOND_DESTINATION_ENDPOINT_ID
            ),
            address(0)
        );
        assertEq(
            originEndpoint.receiveLibraries(
                address(originRouter),
                SECOND_DESTINATION_ENDPOINT_ID
            ),
            address(0)
        );
    }

    function testEndpointIdReverseMappingSupportsDomainZeroAndRejectsAliases()
        public
    {
        _configure(
            originRouter,
            originUln,
            0,
            SECOND_DESTINATION_ENDPOINT_ID,
            address(destinationRouter)
        );

        (bool enrolled, uint32 domainId) = originRouter.remoteLzEndpoints(
            SECOND_DESTINATION_ENDPOINT_ID
        );
        assertTrue(enrolled);
        assertEq(domainId, 0);
        assertTrue(
            originRouter.allowInitializePath(
                LayerZeroOrigin({
                    srcEid: SECOND_DESTINATION_ENDPOINT_ID,
                    sender: address(destinationRouter).addressToBytes32(),
                    nonce: 1
                })
            )
        );
        LayerZeroV2OffchainLookupHookIsm.RemoteRouterConfig
            memory aliasConfig = _defaultRemoteRouterConfig();
        aliasConfig.domainId = SECOND_DESTINATION;
        aliasConfig.endpointId = SECOND_DESTINATION_ENDPOINT_ID;
        vm.expectRevert(
            abi.encodeWithSelector(
                LayerZeroV2OffchainLookupHookIsm
                    .LayerZeroEndpointIdAssignedToAnotherDomain
                    .selector,
                SECOND_DESTINATION_ENDPOINT_ID,
                0
            )
        );
        originRouter.enrollLayerZeroRemoteRouter(aliasConfig);

        originRouter.unenrollRemoteRouter(0);
        (enrolled, domainId) = originRouter.remoteLzEndpoints(
            SECOND_DESTINATION_ENDPOINT_ID
        );
        assertFalse(enrolled);
        assertEq(domainId, 0);
        assertFalse(
            originRouter.allowInitializePath(
                LayerZeroOrigin({
                    srcEid: SECOND_DESTINATION_ENDPOINT_ID,
                    sender: address(destinationRouter).addressToBytes32(),
                    nonce: 1
                })
            )
        );

        originRouter.enrollLayerZeroRemoteRouter(aliasConfig);
        (enrolled, domainId) = originRouter.remoteLzEndpoints(
            SECOND_DESTINATION_ENDPOINT_ID
        );
        assertTrue(enrolled);
        assertEq(domainId, SECOND_DESTINATION);
    }

    function testEndpointIdCanBeReusedAfterRouteMoves() public {
        LayerZeroV2OffchainLookupHookIsm.RemoteRouterConfig
            memory remoteConfig = _defaultRemoteRouterConfig();
        remoteConfig.endpointId = SECOND_DESTINATION_ENDPOINT_ID;
        originRouter.enrollLayerZeroRemoteRouter(remoteConfig);

        remoteConfig.domainId = SECOND_DESTINATION;
        remoteConfig.domainIsm = address(0xBEEF).addressToBytes32();
        remoteConfig.endpointId = DESTINATION_ENDPOINT_ID;
        originRouter.enrollLayerZeroRemoteRouter(remoteConfig);

        assertEq(
            originRouter.remoteLzEndpointIds(DESTINATION),
            SECOND_DESTINATION_ENDPOINT_ID
        );
        assertEq(
            originRouter.remoteLzEndpointIds(SECOND_DESTINATION),
            DESTINATION_ENDPOINT_ID
        );
        (bool enrolled, uint32 domainId) = originRouter.remoteLzEndpoints(
            DESTINATION_ENDPOINT_ID
        );
        assertTrue(enrolled);
        assertEq(domainId, SECOND_DESTINATION);
    }

    function testEnrollmentValidation() public {
        LayerZeroV2OffchainLookupHookIsm.RemoteRouterConfig
            memory remoteConfig = _defaultRemoteRouterConfig();

        remoteConfig.domainId = ORIGIN;
        vm.expectRevert(
            abi.encodeWithSelector(
                LayerZeroV2OffchainLookupHookIsm.InvalidRemoteDomain.selector,
                ORIGIN
            )
        );
        originRouter.enrollLayerZeroRemoteRouter(remoteConfig);

        remoteConfig = _defaultRemoteRouterConfig();
        remoteConfig.endpointId = ORIGIN_ENDPOINT_ID;
        vm.expectRevert(
            abi.encodeWithSelector(
                LayerZeroV2OffchainLookupHookIsm
                    .InvalidRemoteEndpointId
                    .selector,
                ORIGIN_ENDPOINT_ID
            )
        );
        originRouter.enrollLayerZeroRemoteRouter(remoteConfig);

        remoteConfig = _defaultRemoteRouterConfig();
        remoteConfig.domainIsm = bytes32(0);
        vm.expectRevert(
            abi.encodeWithSelector(
                LayerZeroV2OffchainLookupHookIsm.InvalidLayerZeroPeer.selector,
                bytes32(0)
            )
        );
        originRouter.enrollLayerZeroRemoteRouter(remoteConfig);

        remoteConfig = _defaultRemoteRouterConfig();
        remoteConfig.endpointId = SECOND_DESTINATION_ENDPOINT_ID;
        originRouter.enrollLayerZeroRemoteRouter(remoteConfig);
        assertEq(
            originRouter.remoteLzEndpointIds(DESTINATION),
            SECOND_DESTINATION_ENDPOINT_ID
        );
        (bool oldEndpointEnrolled, ) = originRouter.remoteLzEndpoints(
            DESTINATION_ENDPOINT_ID
        );
        assertFalse(oldEndpointEnrolled);

        remoteConfig = _defaultRemoteRouterConfig();
        remoteConfig.domainId = SECOND_DESTINATION;
        remoteConfig.domainIsm = address(0xBEEF).addressToBytes32();
        remoteConfig.endpointId = SECOND_DESTINATION_ENDPOINT_ID;
        vm.expectRevert(
            abi.encodeWithSelector(
                LayerZeroV2OffchainLookupHookIsm
                    .LayerZeroEndpointIdAssignedToAnotherDomain
                    .selector,
                SECOND_DESTINATION_ENDPOINT_ID,
                DESTINATION
            )
        );
        originRouter.enrollLayerZeroRemoteRouter(remoteConfig);

        originRouter.unenrollRemoteRouter(DESTINATION);
        remoteConfig = _defaultRemoteRouterConfig();
        remoteConfig.receiveConfig = new LayerZeroSetConfigParam[](1);
        remoteConfig.receiveConfig[0] = LayerZeroSetConfigParam({
            eid: DESTINATION_ENDPOINT_ID,
            configType: 1,
            config: hex""
        });
        vm.expectRevert(
            abi.encodeWithSelector(
                LayerZeroV2OffchainLookupHookIsm
                    .InvalidLayerZeroConfigType
                    .selector,
                1
            )
        );
        originRouter.enrollLayerZeroRemoteRouter(remoteConfig);
    }

    function testEnrollsExplicitReceiveLibraryWithoutEndpointDefault() public {
        LayerZeroV2OffchainLookupHookIsm.RemoteRouterConfig
            memory remoteConfig = _defaultRemoteRouterConfig();
        remoteConfig.domainId = SECOND_DESTINATION;
        remoteConfig.endpointId = SECOND_DESTINATION_ENDPOINT_ID;
        remoteConfig.domainIsm = address(0xBEEF).addressToBytes32();

        assertEq(
            originEndpoint.defaultReceiveLibraries(
                SECOND_DESTINATION_ENDPOINT_ID
            ),
            address(0)
        );
        originRouter.enrollLayerZeroRemoteRouter(remoteConfig);

        (address receiveLibrary, bool isDefault) = originEndpoint
            .getReceiveLibrary(
                address(originRouter),
                SECOND_DESTINATION_ENDPOINT_ID
            );
        assertEq(receiveLibrary, address(originUln));
        assertFalse(isDefault);
    }

    function testFullWidthPeerAuthentication() public {
        bytes32 nonEvmPeer = bytes32(type(uint256).max);
        LayerZeroSetConfigParam[]
            memory emptyConfig = new LayerZeroSetConfigParam[](0);
        destinationRouter.unenrollRemoteRouter(ORIGIN);
        destinationRouter.enrollLayerZeroRemoteRouter(
            LayerZeroV2OffchainLookupHookIsm.RemoteRouterConfig({
                domainId: ORIGIN,
                domainIsm: nonEvmPeer,
                endpointId: ORIGIN_ENDPOINT_ID,
                sendLibrary: address(destinationUln),
                receiveLibrary: address(destinationUln),
                sendConfig: emptyConfig,
                receiveConfig: emptyConfig
            })
        );
        assertTrue(
            destinationRouter.allowInitializePath(
                LayerZeroOrigin({
                    srcEid: ORIGIN_ENDPOINT_ID,
                    sender: nonEvmPeer,
                    nonce: 1
                })
            )
        );

        (bytes memory message, ) = _dispatch();
        bytes memory packet = originEndpoint.lastPacket();
        (uint64 nonce, , ) = this.decodeLayerZeroPacket(packet);
        bytes32 guid = keccak256(
            abi.encodePacked(
                nonce,
                ORIGIN_ENDPOINT_ID,
                nonEvmPeer,
                DESTINATION_ENDPOINT_ID,
                address(destinationRouter).addressToBytes32()
            )
        );
        // PacketV1Codec places the sender at byte 13 and GUID at byte 81.
        packet = _replace(packet, 13, abi.encodePacked(nonEvmPeer));
        packet = _replace(packet, 81, abi.encodePacked(guid));

        bytes32 truncatedPeer = bytes32(uint256(uint160(uint256(nonEvmPeer))));
        _expectPacketRevert(
            message,
            _replace(packet, 13, abi.encodePacked(truncatedPeer)),
            LayerZeroV2OffchainLookupHookIsm.WrongPacketSender.selector
        );
        _expectPacketRevert(
            message,
            _replace(packet, 81, abi.encodePacked(bytes32(0))),
            LayerZeroV2OffchainLookupHookIsm.WrongPacketGuid.selector
        );

        LayerZeroV2OffchainLookupHookIsm.RemoteRouterConfig
            memory newRemoteConfig = LayerZeroV2OffchainLookupHookIsm
                .RemoteRouterConfig({
                    domainId: ORIGIN,
                    domainIsm: bytes32(uint256(1) << 255),
                    endpointId: ORIGIN_ENDPOINT_ID,
                    sendLibrary: address(destinationUln),
                    receiveLibrary: address(destinationUln),
                    sendConfig: emptyConfig,
                    receiveConfig: emptyConfig
                });
        destinationRouter.unenrollRemoteRouter(ORIGIN);
        destinationRouter.enrollLayerZeroRemoteRouter(newRemoteConfig);
        _expectPacketRevert(
            message,
            packet,
            LayerZeroV2OffchainLookupHookIsm.WrongPacketSender.selector
        );
        newRemoteConfig.domainIsm = nonEvmPeer;
        destinationRouter.unenrollRemoteRouter(ORIGIN);
        destinationRouter.enrollLayerZeroRemoteRouter(newRemoteConfig);

        destinationMailbox.process(
            abi.encode(address(destinationUln), packet),
            message
        );
        assertEq(recipient.lastData(), bytes("hyperlane over layerzero"));
    }

    function testFullWidthPeerGuidGoldenVector() public pure {
        bytes32 sender = 0x8000000000000000000000000000000000000000000000000000000000000001;
        bytes32 receiver = bytes32(uint256(0xDEADBEEF));
        // Fixed LayerZero GUID preimage: nonce (8), IDs (4 each), peers (32 each).
        bytes32 guid = keccak256(
            abi.encodePacked(
                uint64(0x0102030405060708),
                uint32(30_168),
                sender,
                uint32(30_101),
                receiver
            )
        );
        assertEq(
            guid,
            0xb0527c25211da638b1476e12ef410ffe04798ae5856ace398acbd2eaa9dd1d0a
        );
    }

    function testNonEvmPeerCanBeUpdatedAndSentTo() public {
        bytes32 nonEvmPeer = bytes32(type(uint256).max);
        LayerZeroV2OffchainLookupHookIsm.RemoteRouterConfig
            memory newRemoteConfig = _defaultRemoteRouterConfig();
        newRemoteConfig.domainIsm = nonEvmPeer;
        originRouter.unenrollRemoteRouter(DESTINATION);
        originRouter.enrollLayerZeroRemoteRouter(newRemoteConfig);
        assertEq(originRouter.routers(DESTINATION), nonEvmPeer);
        _dispatch();
        assertEq(
            originEndpoint.outboundNonces(
                address(originRouter),
                DESTINATION_ENDPOINT_ID,
                nonEvmPeer
            ),
            1
        );
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
                LayerZeroV2OffchainLookupHookIsm
                    .MessageNotLatestDispatched
                    .selector,
                messageId
            )
        );
        originRouter.postDispatch{value: NATIVE_FEE}("", message);

        vm.expectRevert(
            abi.encodeWithSelector(
                LayerZeroV2OffchainLookupHookIsm
                    .InsufficientLayerZeroFee
                    .selector,
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
                LayerZeroV2OffchainLookupHookIsm
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
                LayerZeroV2OffchainLookupHookIsm
                    .UnsupportedLayerZeroTokenFee
                    .selector,
                1
            )
        );
        originRouter.quoteDispatch("", message);

        vm.expectRevert(
            abi.encodeWithSelector(
                LayerZeroV2OffchainLookupHookIsm
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
        MockLayerZeroReceiveUln replacement = new MockLayerZeroReceiveUln(
            address(originEndpoint)
        );
        originEndpoint.registerMockLibrary(address(replacement));
        LayerZeroSetConfigParam[]
            memory emptyConfig = new LayerZeroSetConfigParam[](0);
        originRouter.unenrollRemoteRouter(DESTINATION);
        originRouter.enrollLayerZeroRemoteRouter(
            LayerZeroV2OffchainLookupHookIsm.RemoteRouterConfig({
                domainId: DESTINATION,
                domainIsm: address(destinationRouter).addressToBytes32(),
                endpointId: DESTINATION_ENDPOINT_ID,
                sendLibrary: address(replacement),
                receiveLibrary: address(originUln),
                sendConfig: emptyConfig,
                receiveConfig: emptyConfig
            })
        );
        assertEq(
            originEndpoint.getSendLibrary(
                address(originRouter),
                DESTINATION_ENDPOINT_ID
            ),
            address(replacement)
        );
        (address receiveLibrary, ) = originEndpoint.getReceiveLibrary(
            address(originRouter),
            DESTINATION_ENDPOINT_ID
        );
        assertEq(receiveLibrary, address(originUln));
    }

    function testEnrollmentInstallsCompletePolicy() public {
        bytes32 newRouter = address(0x1234).addressToBytes32();
        LayerZeroSetConfigParam[]
            memory sendConfig = new LayerZeroSetConfigParam[](1);
        sendConfig[0] = LayerZeroSetConfigParam({
            eid: DESTINATION_ENDPOINT_ID,
            configType: 1,
            config: hex"1234"
        });
        LayerZeroSetConfigParam[]
            memory receiveConfig = new LayerZeroSetConfigParam[](1);
        receiveConfig[0] = LayerZeroSetConfigParam({
            eid: DESTINATION_ENDPOINT_ID,
            configType: 2,
            config: hex"abcd"
        });
        LayerZeroV2OffchainLookupHookIsm.RemoteRouterConfig
            memory newRemoteConfig = _defaultRemoteRouterConfig();
        newRemoteConfig.domainIsm = newRouter;
        newRemoteConfig.sendConfig = sendConfig;
        newRemoteConfig.receiveConfig = receiveConfig;
        originRouter.unenrollRemoteRouter(DESTINATION);
        originRouter.enrollLayerZeroRemoteRouter(newRemoteConfig);

        assertEq(originRouter.routers(DESTINATION), newRouter);
        assertEq(
            originEndpoint.getSendLibrary(
                address(originRouter),
                DESTINATION_ENDPOINT_ID
            ),
            address(originUln)
        );
        (address receiveLibrary, ) = originEndpoint.getReceiveLibrary(
            address(originRouter),
            DESTINATION_ENDPOINT_ID
        );
        assertEq(receiveLibrary, address(originUln));
        assertEq(
            originEndpoint.getConfig(
                address(originRouter),
                address(originUln),
                DESTINATION_ENDPOINT_ID,
                1
            ),
            hex"1234"
        );
        assertEq(
            originEndpoint.getConfig(
                address(originRouter),
                address(originUln),
                DESTINATION_ENDPOINT_ID,
                2
            ),
            hex"abcd"
        );
    }

    function testEnrollmentRollsBackOnInvalidConfigEndpointId() public {
        bytes32 currentRouter = originRouter.routers(DESTINATION);
        LayerZeroSetConfigParam[]
            memory sendConfig = new LayerZeroSetConfigParam[](1);
        sendConfig[0] = LayerZeroSetConfigParam({
            eid: ORIGIN_ENDPOINT_ID,
            configType: 1,
            config: hex"1234"
        });
        vm.expectRevert(
            abi.encodeWithSelector(
                LayerZeroV2OffchainLookupHookIsm
                    .InvalidLayerZeroConfigEndpointId
                    .selector,
                ORIGIN_ENDPOINT_ID
            )
        );
        LayerZeroV2OffchainLookupHookIsm.RemoteRouterConfig
            memory newRemoteConfig = _defaultRemoteRouterConfig();
        newRemoteConfig.domainId = SECOND_DESTINATION;
        newRemoteConfig.endpointId = SECOND_DESTINATION_ENDPOINT_ID;
        newRemoteConfig.domainIsm = address(0x1234).addressToBytes32();
        newRemoteConfig.sendConfig = sendConfig;
        originRouter.enrollLayerZeroRemoteRouter(newRemoteConfig);
        assertEq(originRouter.routers(DESTINATION), currentRouter);
    }

    function testBatchEnrollmentIsAtomic() public {
        _configure(
            originRouter,
            originUln,
            SECOND_DESTINATION,
            SECOND_DESTINATION_ENDPOINT_ID,
            address(0xABCD)
        );
        originRouter.unenrollRemoteRouter(DESTINATION);
        originRouter.unenrollRemoteRouter(SECOND_DESTINATION);
        LayerZeroV2OffchainLookupHookIsm.RemoteRouterConfig[]
            memory newRemoteConfigs = new LayerZeroV2OffchainLookupHookIsm.RemoteRouterConfig[](
                2
            );
        newRemoteConfigs[0] = _defaultRemoteRouterConfig();
        newRemoteConfigs[0].domainIsm = address(0x1234).addressToBytes32();
        newRemoteConfigs[1] = _defaultRemoteRouterConfig();
        newRemoteConfigs[1].domainId = SECOND_DESTINATION;
        newRemoteConfigs[1].endpointId = SECOND_DESTINATION_ENDPOINT_ID;
        newRemoteConfigs[1].domainIsm = address(0x5678).addressToBytes32();

        originRouter.enrollLayerZeroRemoteRouters(newRemoteConfigs);
        assertEq(
            originRouter.routers(DESTINATION),
            address(0x1234).addressToBytes32()
        );
        assertEq(
            originRouter.routers(SECOND_DESTINATION),
            address(0x5678).addressToBytes32()
        );
    }

    function testBatchEnrollmentRollsBackTogether() public {
        _configure(
            originRouter,
            originUln,
            SECOND_DESTINATION,
            SECOND_DESTINATION_ENDPOINT_ID,
            address(0xABCD)
        );
        originRouter.unenrollRemoteRouter(DESTINATION);
        originRouter.unenrollRemoteRouter(SECOND_DESTINATION);
        LayerZeroV2OffchainLookupHookIsm.RemoteRouterConfig[]
            memory newRemoteConfigs = new LayerZeroV2OffchainLookupHookIsm.RemoteRouterConfig[](
                2
            );
        newRemoteConfigs[0] = _defaultRemoteRouterConfig();
        newRemoteConfigs[0].domainIsm = address(0x1234).addressToBytes32();
        newRemoteConfigs[1] = _defaultRemoteRouterConfig();
        newRemoteConfigs[1].domainId = SECOND_DESTINATION;
        newRemoteConfigs[1].endpointId = SECOND_DESTINATION_ENDPOINT_ID;
        newRemoteConfigs[1].domainIsm = bytes32(0);

        vm.expectRevert(
            abi.encodeWithSelector(
                LayerZeroV2OffchainLookupHookIsm.InvalidLayerZeroPeer.selector,
                bytes32(0)
            )
        );
        originRouter.enrollLayerZeroRemoteRouters(newRemoteConfigs);
        assertEq(originRouter.routers(DESTINATION), bytes32(0));
        assertEq(originRouter.routers(SECOND_DESTINATION), bytes32(0));
    }

    function testConfigurationIsOwnerGated() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert("Ownable: caller is not the owner");
        originRouter.enrollLayerZeroRemoteRouter(_defaultRemoteRouterConfig());
    }

    function testAtomicEnrollmentRollsBackIncompleteRoute() public {
        LayerZeroV2OffchainLookupHookIsm router = _deploy(
            address(originMailbox),
            address(originEndpoint)
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                LayerZeroV2OffchainLookupHookIsm
                    .UnregisteredLayerZeroLibrary
                    .selector,
                address(0)
            )
        );
        LayerZeroSetConfigParam[]
            memory emptyConfig = new LayerZeroSetConfigParam[](0);
        router.enrollLayerZeroRemoteRouter(
            LayerZeroV2OffchainLookupHookIsm.RemoteRouterConfig({
                domainId: DESTINATION,
                domainIsm: address(destinationRouter).addressToBytes32(),
                endpointId: DESTINATION_ENDPOINT_ID,
                sendLibrary: address(0),
                receiveLibrary: address(originUln),
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
        assertEq(
            originRouter.nextNonce(DESTINATION_ENDPOINT_ID, bytes32(0)),
            0
        );
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

    function _packetWithNonce(
        bytes memory packet,
        uint64 nonce
    ) internal view returns (bytes memory) {
        packet = _replace(packet, 1, abi.encodePacked(nonce));
        bytes32 guid = GUID.generate(
            nonce,
            ORIGIN_ENDPOINT_ID,
            address(originRouter),
            DESTINATION_ENDPOINT_ID,
            address(destinationRouter).addressToBytes32()
        );
        return _replace(packet, 81, abi.encodePacked(guid));
    }

    function _precommitPacket(
        bytes memory packet
    ) internal returns (bytes32 payloadHash) {
        (uint64 nonce, , bytes32 hash) = this.decodeLayerZeroPacket(packet);
        payloadHash = hash;
        vm.prank(address(destinationUln));
        destinationEndpoint.mockVerify(
            address(destinationRouter),
            ORIGIN_ENDPOINT_ID,
            address(originRouter).addressToBytes32(),
            nonce,
            payloadHash
        );
    }

    function _dispatchUnrelated()
        internal
        returns (bytes memory message, bytes memory packet)
    {
        TestRecipient unrelatedRecipient = new TestRecipient();
        TestIsm unrelatedIsm = new TestIsm();
        unrelatedRecipient.setInterchainSecurityModule(address(unrelatedIsm));
        bytes memory body = bytes("unrelated message");
        message = originMailbox.buildOutboundMessage(
            DESTINATION,
            address(unrelatedRecipient).addressToBytes32(),
            body
        );
        originMailbox.dispatch{value: NATIVE_FEE}(
            DESTINATION,
            address(unrelatedRecipient).addressToBytes32(),
            body,
            "",
            IPostDispatchHook(address(originRouter))
        );
        packet = originEndpoint.lastPacket();
    }

    function _replaceDestinationReceiveLibrary(
        MockLayerZeroReceiveUln replacement
    ) internal {
        destinationEndpoint.registerMockLibrary(address(replacement));
        LayerZeroSetConfigParam[]
            memory emptyConfig = new LayerZeroSetConfigParam[](0);
        destinationRouter.enrollLayerZeroRemoteRouter(
            LayerZeroV2OffchainLookupHookIsm.RemoteRouterConfig({
                domainId: ORIGIN,
                domainIsm: address(originRouter).addressToBytes32(),
                endpointId: ORIGIN_ENDPOINT_ID,
                sendLibrary: address(destinationUln),
                receiveLibrary: address(replacement),
                sendConfig: emptyConfig,
                receiveConfig: emptyConfig
            })
        );
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
        bytes memory packet = originEndpoint.lastPacket();
        bytes memory metadata = abi.encode(address(destinationUln), packet);
        destinationMailbox.process(metadata, message);
        assertEq(recipient.lastData(), bytes("hyperlane over layerzero"));
        assertEq(
            destinationEndpoint.inboundPayloadHash(
                address(destinationRouter),
                ORIGIN_ENDPOINT_ID,
                address(originRouter).addressToBytes32(),
                1
            ),
            bytes32(0)
        );
        assertEq(
            destinationEndpoint.lazyInboundNonce(
                address(destinationRouter),
                ORIGIN_ENDPOINT_ID,
                address(originRouter).addressToBytes32()
            ),
            1
        );
    }

    function testPullSingleMessageFitsBacklogGasLimit() public {
        (bytes memory message, ) = _dispatch();
        bytes memory packet = originEndpoint.lastPacket();
        (bool success, ) = address(destinationMailbox).call{
            gas: PROCESS_GAS_LIMIT
        }(
            abi.encodeCall(
                destinationMailbox.process,
                (abi.encode(address(destinationUln), packet), message)
            )
        );
        assertTrue(success, "single LayerZero message exceeded process gas");
    }

    function testPullUnverifiedPredecessorEmitsClearFailureWithoutBlocking()
        public
    {
        (bytes memory unrelatedMessage, ) = _dispatchUnrelated();
        destinationMailbox.process("", unrelatedMessage);

        (bytes memory message, bytes32 messageId) = _dispatch();
        bytes memory packet = originEndpoint.lastPacket();
        (uint64 packetNonce, bytes32 guid, bytes32 payloadHash) = this
            .decodeLayerZeroPacket(packet);
        assertEq(packetNonce, 2);

        vm.recordLogs();
        destinationMailbox.process(
            abi.encode(address(destinationUln), packet),
            message
        );
        assertEq(recipient.lastData(), bytes("hyperlane over layerzero"));

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 eventSignature = keccak256(
            "LayerZeroPayloadClearFailed(bytes32,uint32,uint32,bytes32,uint64)"
        );
        bool foundFailure;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (
                logs[i].topics.length != 0 &&
                logs[i].emitter == address(destinationRouter) &&
                logs[i].topics[0] == eventSignature
            ) {
                foundFailure = true;
                assertEq(logs[i].topics[1], messageId);
                assertEq(logs[i].topics[2], bytes32(uint256(ORIGIN)));
                assertEq(
                    logs[i].topics[3],
                    bytes32(uint256(ORIGIN_ENDPOINT_ID))
                );
                (bytes32 emittedGuid, uint64 emittedNonce) = abi.decode(
                    logs[i].data,
                    (bytes32, uint64)
                );
                assertEq(emittedGuid, guid);
                assertEq(emittedNonce, packetNonce);
                break;
            }
        }
        assertTrue(foundFailure, "missing clear failure event");
        assertEq(
            destinationEndpoint.inboundPayloadHash(
                address(destinationRouter),
                ORIGIN_ENDPOINT_ID,
                address(originRouter).addressToBytes32(),
                packetNonce
            ),
            payloadHash
        );
    }

    function testPullEndpointExecutionRecoversFailedCleanupPermissionlessly()
        public
    {
        (
            bytes memory unrelatedMessage,
            bytes memory predecessorPacket
        ) = _dispatchUnrelated();
        destinationMailbox.process("", unrelatedMessage);

        (bytes memory message, bytes32 messageId) = _dispatch();
        bytes memory packet = originEndpoint.lastPacket();
        (uint64 nonce, bytes32 guid, ) = this.decodeLayerZeroPacket(packet);
        bytes memory metadata = abi.encode(address(destinationUln), packet);
        destinationMailbox.process(metadata, message);
        _precommitPacket(predecessorPacket);

        vm.prank(address(0xBEEF));
        destinationEndpoint.mockExecute(
            address(destinationRouter),
            LayerZeroOrigin({
                srcEid: ORIGIN_ENDPOINT_ID,
                sender: address(originRouter).addressToBytes32(),
                nonce: nonce
            }),
            guid,
            LayerZeroMessage.encode(ORIGIN, DESTINATION, messageId)
        );

        assertEq(
            destinationEndpoint.lazyInboundNonce(
                address(destinationRouter),
                ORIGIN_ENDPOINT_ID,
                address(originRouter).addressToBytes32()
            ),
            2
        );
        assertNotEq(
            destinationEndpoint.inboundPayloadHash(
                address(destinationRouter),
                ORIGIN_ENDPOINT_ID,
                address(originRouter).addressToBytes32(),
                1
            ),
            bytes32(0)
        );
        assertEq(
            destinationEndpoint.inboundPayloadHash(
                address(destinationRouter),
                ORIGIN_ENDPOINT_ID,
                address(originRouter).addressToBytes32(),
                2
            ),
            bytes32(0)
        );
    }

    function testPullMaximumSparseNonceFitsGasLimit() public {
        (bytes memory message, ) = _dispatch();
        bytes memory packet = _packetWithNonce(
            originEndpoint.lastPacket(),
            type(uint64).max
        );

        (bool success, ) = address(destinationMailbox).call{
            gas: PROCESS_GAS_LIMIT
        }(
            abi.encodeCall(
                destinationMailbox.process,
                (abi.encode(address(destinationUln), packet), message)
            )
        );
        assertTrue(success, "LayerZero nonce affected process gas");
    }

    function testPullVerifiedBacklogCannotExhaustLaterMessageGas() public {
        TestRecipient unrelatedRecipient = new TestRecipient();
        TestIsm unrelatedIsm = new TestIsm();
        unrelatedRecipient.setInterchainSecurityModule(address(unrelatedIsm));
        uint64 backlogSize = 256;

        for (uint64 i = 1; i <= backlogSize; ++i) {
            originMailbox.dispatch{value: NATIVE_FEE}(
                DESTINATION,
                address(unrelatedRecipient).addressToBytes32(),
                abi.encode(i),
                "",
                IPostDispatchHook(address(originRouter))
            );
            bytes memory packet = originEndpoint.lastPacket();
            (uint64 packetNonce, , bytes32 packetPayloadHash) = this
                .decodeLayerZeroPacket(packet);
            vm.prank(address(destinationUln));
            destinationEndpoint.mockVerify(
                address(destinationRouter),
                ORIGIN_ENDPOINT_ID,
                address(originRouter).addressToBytes32(),
                packetNonce,
                packetPayloadHash
            );
        }

        (bytes memory message, ) = _dispatch();
        bytes memory latestPacket = originEndpoint.lastPacket();
        (uint64 latestNonce, , ) = this.decodeLayerZeroPacket(latestPacket);
        assertEq(latestNonce, backlogSize + 1);

        (bool success, ) = address(destinationMailbox).call{
            gas: PROCESS_GAS_LIMIT
        }(
            abi.encodeCall(
                destinationMailbox.process,
                (abi.encode(address(destinationUln), latestPacket), message)
            )
        );
        assertTrue(success, "verified LayerZero backlog exhausted process gas");
        assertEq(recipient.lastData(), bytes("hyperlane over layerzero"));
    }

    function testPullPrecommittedPacketSkipsUnavailableReceiveLibrary() public {
        (bytes memory message, ) = _dispatch();
        bytes memory packet = originEndpoint.lastPacket();
        _precommitPacket(packet);
        destinationUln.setReady(false);

        destinationMailbox.process(
            abi.encode(address(destinationUln), packet),
            message
        );

        assertEq(
            destinationEndpoint.inboundPayloadHash(
                address(destinationRouter),
                ORIGIN_ENDPOINT_ID,
                address(originRouter).addressToBytes32(),
                1
            ),
            bytes32(0)
        );
    }

    function testPullPrecommittedPacketSurvivesReceiveLibraryRotation() public {
        (bytes memory message, ) = _dispatch();
        bytes memory packet = originEndpoint.lastPacket();
        _precommitPacket(packet);
        MockLayerZeroReceiveUln replacement = new MockLayerZeroReceiveUln(
            address(destinationEndpoint)
        );
        _replaceDestinationReceiveLibrary(replacement);

        destinationMailbox.process(
            abi.encode(address(destinationUln), packet),
            message
        );

        assertEq(
            destinationEndpoint.inboundPayloadHash(
                address(destinationRouter),
                ORIGIN_ENDPOINT_ID,
                address(originRouter).addressToBytes32(),
                1
            ),
            bytes32(0)
        );
    }

    function testPullUncommittedPacketRequiresCurrentReceiveLibrary() public {
        (bytes memory message, ) = _dispatch();
        bytes memory packet = originEndpoint.lastPacket();
        MockLayerZeroReceiveUln replacement = new MockLayerZeroReceiveUln(
            address(destinationEndpoint)
        );
        _replaceDestinationReceiveLibrary(replacement);

        vm.expectRevert(
            abi.encodeWithSelector(
                LayerZeroV2OffchainLookupHookIsm.InvalidReceiveLibrary.selector,
                address(destinationUln)
            )
        );
        destinationMailbox.process(
            abi.encode(address(destinationUln), packet),
            message
        );

        destinationMailbox.process(
            abi.encode(address(replacement), packet),
            message
        );
        assertEq(recipient.lastData(), bytes("hyperlane over layerzero"));
    }

    function testPullBacklogOnAnotherPathDoesNotAffectProcessGas() public {
        bytes32 unrelatedSender = address(0xBEEF).addressToBytes32();
        for (uint64 nonce = 1; nonce <= 256; ++nonce) {
            vm.prank(address(destinationUln));
            destinationEndpoint.mockVerify(
                address(destinationRouter),
                SECOND_DESTINATION_ENDPOINT_ID,
                unrelatedSender,
                nonce,
                bytes32(uint256(nonce))
            );
        }

        (bytes memory message, ) = _dispatch();
        bytes memory packet = originEndpoint.lastPacket();
        (bool success, ) = address(destinationMailbox).call{
            gas: PROCESS_GAS_LIMIT
        }(
            abi.encodeCall(
                destinationMailbox.process,
                (abi.encode(address(destinationUln), packet), message)
            )
        );
        assertTrue(success, "unrelated LayerZero path affected process gas");
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

    function testPullRejectsUnauthorizedCallback() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                LayerZeroV2OffchainLookupHookIsm.UnauthorizedCaller.selector,
                address(this)
            )
        );
        LayerZeroV2OffchainLookupHookIsm(address(destinationRouter)).lzReceive(
            LayerZeroOrigin({
                srcEid: ORIGIN_ENDPOINT_ID,
                sender: bytes32(0),
                nonce: 1
            }),
            bytes32(0),
            "",
            address(this),
            ""
        );
    }

    function testPullEndpointExecutionCannotConsumeVerifiedPacket() public {
        (, bytes32 messageId) = _dispatch();
        bytes memory packet = originEndpoint.lastPacket();
        (uint64 nonce, bytes32 guid, bytes32 payloadHash) = this
            .decodeLayerZeroPacket(packet);
        _precommitPacket(packet);

        LayerZeroOrigin memory origin = LayerZeroOrigin({
            srcEid: ORIGIN_ENDPOINT_ID,
            sender: address(originRouter).addressToBytes32(),
            nonce: nonce
        });
        vm.expectRevert(
            abi.encodeWithSelector(
                LayerZeroV2OffchainLookupHookIsm.MessageNotDelivered.selector,
                messageId
            )
        );
        destinationEndpoint.mockExecute(
            address(destinationRouter),
            origin,
            guid,
            LayerZeroMessage.encode(ORIGIN, DESTINATION, messageId)
        );

        assertEq(
            destinationEndpoint.inboundPayloadHash(
                address(destinationRouter),
                ORIGIN_ENDPOINT_ID,
                address(originRouter).addressToBytes32(),
                nonce
            ),
            payloadHash
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
                LayerZeroV2OffchainLookupHookIsm
                    .MessageNotBeingProcessed
                    .selector,
                Message.id(message)
            )
        );
        LayerZeroV2OffchainLookupHookIsm(address(destinationRouter)).verify(
            metadata,
            message
        );
    }

    function testPullVerifiesThroughAggregationIsm() public {
        (bytes memory message, ) = _dispatch();
        bytes memory layerZeroMetadata = abi.encode(
            address(destinationUln),
            originEndpoint.lastPacket()
        );
        TestIsm testIsm = new TestIsm();
        address[] memory modules = new address[](2);
        modules[0] = address(testIsm);
        modules[1] = address(destinationRouter);
        IInterchainSecurityModule aggregation = IInterchainSecurityModule(
            new StaticAggregationIsmFactory().deploy(modules, 2)
        );
        recipient.setInterchainSecurityModule(address(aggregation));

        bytes memory metadata = abi.encodePacked(
            uint32(16),
            uint32(16),
            uint32(16),
            uint32(16 + layerZeroMetadata.length),
            layerZeroMetadata
        );
        destinationMailbox.process(metadata, message);

        assertEq(recipient.lastData(), bytes("hyperlane over layerzero"));
    }

    function testPullVerifiesThroughRoutingIsm() public {
        (bytes memory message, ) = _dispatch();
        DomainRoutingIsm routing = new DomainRoutingIsm();
        routing.initialize(address(this));
        routing.set(
            ORIGIN,
            IInterchainSecurityModule(address(destinationRouter))
        );
        recipient.setInterchainSecurityModule(address(routing));

        destinationMailbox.process(
            abi.encode(address(destinationUln), originEndpoint.lastPacket()),
            message
        );

        assertEq(recipient.lastData(), bytes("hyperlane over layerzero"));
    }

    function testPullRollbackWhenRecipientReverts() public {
        (bytes memory message, ) = _dispatch();
        bytes memory packet = originEndpoint.lastPacket();
        bytes memory metadata = abi.encode(address(destinationUln), packet);
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
                ORIGIN_ENDPOINT_ID,
                address(originRouter).addressToBytes32(),
                1
            ),
            bytes32(0)
        );

        vm.clearMockedCalls();
        destinationMailbox.process(metadata, message);
        assertEq(
            destinationEndpoint.inboundPayloadHash(
                address(destinationRouter),
                ORIGIN_ENDPOINT_ID,
                address(originRouter).addressToBytes32(),
                1
            ),
            bytes32(0)
        );
    }

    function testPullPrecommittedHashSurvivesRecipientRevertAndRetry() public {
        (bytes memory message, ) = _dispatch();
        bytes memory packet = originEndpoint.lastPacket();
        bytes32 payloadHash = _precommitPacket(packet);
        bytes memory metadata = abi.encode(address(destinationUln), packet);
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
                ORIGIN_ENDPOINT_ID,
                address(originRouter).addressToBytes32(),
                1
            ),
            payloadHash
        );

        vm.clearMockedCalls();
        destinationMailbox.process(metadata, message);
        assertEq(recipient.lastData(), bytes("hyperlane over layerzero"));
        assertEq(
            destinationEndpoint.inboundPayloadHash(
                address(destinationRouter),
                ORIGIN_ENDPOINT_ID,
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
            ORIGIN_ENDPOINT_ID,
            address(originRouter).addressToBytes32(),
            packetNonce,
            bytes32(uint256(1))
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                LayerZeroV2OffchainLookupHookIsm
                    .ConflictingPayloadHash
                    .selector,
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

    function testPullInvalidAttemptDoesNotPoisonValidDelivery() public {
        (bytes memory message, ) = _dispatch();
        bytes memory packet = originEndpoint.lastPacket();
        bytes memory invalidPacket = _replace(
            packet,
            13,
            abi.encodePacked(address(0xBEEF).addressToBytes32())
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                LayerZeroV2OffchainLookupHookIsm.WrongPacketSender.selector,
                address(0xBEEF).addressToBytes32(),
                address(originRouter).addressToBytes32()
            )
        );
        destinationMailbox.process(
            abi.encode(address(destinationUln), invalidPacket),
            message
        );

        destinationMailbox.process(
            abi.encode(address(destinationUln), packet),
            message
        );
        assertEq(recipient.lastData(), bytes("hyperlane over layerzero"));
    }

    function testPullMailboxReplayProtectionAfterVerification() public {
        (bytes memory message, ) = _dispatch();
        bytes memory metadata = abi.encode(
            address(destinationUln),
            originEndpoint.lastPacket()
        );
        destinationMailbox.process(metadata, message);

        vm.expectRevert(bytes("Mailbox: already delivered"));
        destinationMailbox.process(metadata, message);
    }

    function testPullBatchEnrollmentAndOffchainLookup() public {
        LayerZeroSetConfigParam[]
            memory emptyConfig = new LayerZeroSetConfigParam[](0);
        LayerZeroV2OffchainLookupHookIsm.RemoteRouterConfig[]
            memory remoteConfigs = new LayerZeroV2OffchainLookupHookIsm.RemoteRouterConfig[](
                1
            );
        remoteConfigs[0] = LayerZeroV2OffchainLookupHookIsm.RemoteRouterConfig({
            domainId: SECOND_DESTINATION,
            domainIsm: address(0xBEEF).addressToBytes32(),
            endpointId: SECOND_DESTINATION_ENDPOINT_ID,
            sendLibrary: address(originUln),
            receiveLibrary: address(originUln),
            sendConfig: emptyConfig,
            receiveConfig: emptyConfig
        });
        LayerZeroV2OffchainLookupHookIsm(address(originRouter))
            .enrollLayerZeroRemoteRouters(remoteConfigs);
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
            LayerZeroV2OffchainLookupHookIsm
                .InvalidLayerZeroPacketLength
                .selector
        );
        _expectPacketRevert(
            message,
            _replace(packet, 0, abi.encodePacked(uint8(2))),
            LayerZeroV2OffchainLookupHookIsm
                .InvalidLayerZeroPacketVersion
                .selector
        );
        _expectPacketRevert(
            message,
            _replace(packet, 9, abi.encodePacked(uint32(123))),
            LayerZeroV2OffchainLookupHookIsm
                .WrongPacketSourceEndpointId
                .selector
        );
        _expectPacketRevert(
            message,
            _replace(
                packet,
                13,
                abi.encodePacked(address(0xBEEF).addressToBytes32())
            ),
            LayerZeroV2OffchainLookupHookIsm.WrongPacketSender.selector
        );
        _expectPacketRevert(
            message,
            _replace(packet, 45, abi.encodePacked(uint32(123))),
            LayerZeroV2OffchainLookupHookIsm
                .WrongPacketDestinationEndpointId
                .selector
        );
        _expectPacketRevert(
            message,
            _replace(
                packet,
                49,
                abi.encodePacked(address(0xBEEF).addressToBytes32())
            ),
            LayerZeroV2OffchainLookupHookIsm.WrongPacketReceiver.selector
        );
        _expectPacketRevert(
            message,
            _replace(packet, 113, abi.encodePacked(uint8(2))),
            LayerZeroV2OffchainLookupHookIsm.WrongPacketMessage.selector
        );
        _expectPacketRevert(
            message,
            _replace(packet, 81, abi.encodePacked(bytes32(uint256(123)))),
            LayerZeroV2OffchainLookupHookIsm.WrongPacketGuid.selector
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                LayerZeroV2OffchainLookupHookIsm.InvalidReceiveLibrary.selector,
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
                LayerZeroV2OffchainLookupHookIsm
                    .MessageNotBeingProcessed
                    .selector,
                messageId
            )
        );
        LayerZeroV2OffchainLookupHookIsm(address(destinationRouter)).verify(
            metadata,
            message
        );
    }
}
