// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {ILayerZeroEndpointV2} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {SetConfigParam as LayerZeroSetConfigParam} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/IMessageLibManager.sol";
import {AbstractLayerZeroV2HookIsm} from "contracts/hooks/layerzero/AbstractLayerZeroV2HookIsm.sol";
import {LayerZeroV2CallbackHookIsm} from "contracts/hooks/layerzero/LayerZeroV2CallbackHookIsm.sol";
import {LayerZeroV2CcipReadHookIsm} from "contracts/hooks/layerzero/LayerZeroV2CcipReadHookIsm.sol";
import {IPostDispatchHook} from "contracts/interfaces/hooks/IPostDispatchHook.sol";
import {Message} from "contracts/libs/Message.sol";
import {TypeCasts} from "contracts/libs/TypeCasts.sol";
import {TestMailbox} from "contracts/test/TestMailbox.sol";
import {TestPostDispatchHook} from "contracts/test/TestPostDispatchHook.sol";

contract LayerZeroV2HookIsmForkTest is Test {
    using Message for bytes;
    using TypeCasts for address;

    uint32 internal constant ETHEREUM_DOMAIN = 1;
    uint32 internal constant ARBITRUM_DOMAIN = 42_161;
    uint32 internal constant ETHEREUM_EID = 30_101;
    uint32 internal constant ARBITRUM_EID = 30_110;
    uint128 internal constant CALLBACK_GAS = 250_000;
    uint256 internal constant ETHEREUM_FORK_BLOCK = 25_878_200;

    ILayerZeroEndpointV2 internal constant ENDPOINT =
        ILayerZeroEndpointV2(0x1a44076050125825900e736c501f859c50fE728c);
    address internal constant SEND_ULN_302 =
        0xbB2Ea70C9E858123480642Cf96acbcCE1372dCe1;
    address internal constant RECEIVE_ULN_302 =
        0xc02Ab410f0734EFa3F14628780e6e695156024C2;

    TestMailbox internal mailbox;
    LayerZeroV2CallbackHookIsm internal router;

    function setUp() public {
        string memory rpcUrl = vm.envOr("LAYERZERO_FORK_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpcUrl, ETHEREUM_FORK_BLOCK);

        assertEq(ENDPOINT.eid(), ETHEREUM_EID);
        assertEq(ENDPOINT.nativeToken(), address(0));
        assertTrue(ENDPOINT.isRegisteredLibrary(SEND_ULN_302));
        assertTrue(ENDPOINT.isRegisteredLibrary(RECEIVE_ULN_302));

        mailbox = new TestMailbox(ETHEREUM_DOMAIN);
        TestPostDispatchHook noopHook = new TestPostDispatchHook();
        mailbox.setDefaultHook(address(noopHook));
        mailbox.setRequiredHook(address(noopHook));
        router = new LayerZeroV2CallbackHookIsm(
            address(mailbox),
            address(ENDPOINT)
        );
    }

    function testProductionEndpointEnrollmentConfigUpdateAndQuote() public {
        LayerZeroSetConfigParam[]
            memory emptyConfig = new LayerZeroSetConfigParam[](0);
        router.enrollLayerZeroRemoteRouter(
            AbstractLayerZeroV2HookIsm.RemoteRouterEnrollment({
                domain: ARBITRUM_DOMAIN,
                router: address(0xBEEF).addressToBytes32(),
                eid: ARBITRUM_EID,
                sendLibrary: SEND_ULN_302,
                receiveLibrary: RECEIVE_ULN_302,
                receiveLibraryGracePeriod: 0,
                receiveLibraryTimeout: address(0),
                receiveLibraryTimeoutExpiry: 0,
                sendConfig: emptyConfig,
                receiveConfig: emptyConfig
            }),
            CALLBACK_GAS
        );

        assertEq(
            ENDPOINT.getSendLibrary(address(router), ARBITRUM_EID),
            SEND_ULN_302
        );
        (address receiveLibrary, bool isDefault) = ENDPOINT.getReceiveLibrary(
            address(router),
            ARBITRUM_EID
        );
        assertEq(receiveLibrary, RECEIVE_ULN_302);
        assertFalse(isDefault);

        bytes memory executorConfig = ENDPOINT.getConfig(
            address(router),
            SEND_ULN_302,
            ARBITRUM_EID,
            1
        );
        (uint32 maxMessageSize, address executor) = abi.decode(
            executorConfig,
            (uint32, address)
        );
        assertGt(maxMessageSize, 1);
        bytes memory updatedExecutorConfig = abi.encode(
            maxMessageSize - 1,
            executor
        );
        LayerZeroSetConfigParam[]
            memory sendConfig = new LayerZeroSetConfigParam[](1);
        sendConfig[0] = LayerZeroSetConfigParam({
            eid: ARBITRUM_EID,
            configType: 1,
            config: updatedExecutorConfig
        });

        router.updateLayerZeroRemoteRouterConfig(
            AbstractLayerZeroV2HookIsm.RemoteRouterConfigUpdate({
                domain: ARBITRUM_DOMAIN,
                router: address(0xCAFE).addressToBytes32(),
                receiveLibraryTimeout: RECEIVE_ULN_302,
                receiveLibraryTimeoutExpiry: block.number + 100,
                sendConfig: sendConfig,
                receiveConfig: emptyConfig
            }),
            275_000
        );

        assertEq(
            ENDPOINT.getConfig(address(router), SEND_ULN_302, ARBITRUM_EID, 1),
            updatedExecutorConfig
        );
        assertEq(
            router.routers(ARBITRUM_DOMAIN),
            address(0xCAFE).addressToBytes32()
        );
        assertEq(router.callbackGasLimits(ARBITRUM_DOMAIN), 275_000);
        (address timeoutLibrary, uint256 timeoutExpiry) = ENDPOINT
            .receiveLibraryTimeout(address(router), ARBITRUM_EID);
        assertEq(timeoutLibrary, RECEIVE_ULN_302);
        assertEq(timeoutExpiry, block.number + 100);

        router.updateLayerZeroRemoteRouterConfig(
            AbstractLayerZeroV2HookIsm.RemoteRouterConfigUpdate({
                domain: ARBITRUM_DOMAIN,
                router: address(0xCAFE).addressToBytes32(),
                receiveLibraryTimeout: address(0),
                receiveLibraryTimeoutExpiry: 0,
                sendConfig: emptyConfig,
                receiveConfig: emptyConfig
            }),
            275_000
        );
        (timeoutLibrary, timeoutExpiry) = ENDPOINT.receiveLibraryTimeout(
            address(router),
            ARBITRUM_EID
        );
        assertEq(timeoutLibrary, address(0));
        assertEq(timeoutExpiry, 0);

        bytes memory message = mailbox.buildOutboundMessage(
            ARBITRUM_DOMAIN,
            address(0x1234).addressToBytes32(),
            bytes("fork quote")
        );
        assertGt(router.quoteDispatch("", message), 0);
    }

    function testProductionEndpointCcipReadEnrollmentAndQuote() public {
        string[] memory urls = new string[](1);
        urls[0] = "https://example.com/layerzero";
        LayerZeroV2CcipReadHookIsm ccipRouter = new LayerZeroV2CcipReadHookIsm(
            address(mailbox),
            address(ENDPOINT),
            urls
        );
        LayerZeroSetConfigParam[]
            memory emptyConfig = new LayerZeroSetConfigParam[](0);
        ccipRouter.enrollLayerZeroRemoteRouter(
            AbstractLayerZeroV2HookIsm.RemoteRouterEnrollment({
                domain: ARBITRUM_DOMAIN,
                router: address(0xBEEF).addressToBytes32(),
                eid: ARBITRUM_EID,
                sendLibrary: SEND_ULN_302,
                receiveLibrary: RECEIVE_ULN_302,
                receiveLibraryGracePeriod: 0,
                receiveLibraryTimeout: address(0),
                receiveLibraryTimeoutExpiry: 0,
                sendConfig: emptyConfig,
                receiveConfig: emptyConfig
            })
        );

        bytes memory message = mailbox.buildOutboundMessage(
            ARBITRUM_DOMAIN,
            address(0x1234).addressToBytes32(),
            bytes("fork pull quote")
        );
        uint256 fee = ccipRouter.quoteDispatch("", message);
        assertGt(fee, 0);
        vm.deal(address(this), fee);
        mailbox.dispatch{value: fee}(
            ARBITRUM_DOMAIN,
            address(0x1234).addressToBytes32(),
            bytes("fork pull quote"),
            "",
            IPostDispatchHook(address(ccipRouter))
        );
        assertTrue(ccipRouter.sent(message.id()));
    }
}
