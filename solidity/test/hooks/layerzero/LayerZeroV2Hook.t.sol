// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {EndpointV2} from "@layerzerolabs/lz-evm-protocol-v2/contracts/EndpointV2.sol";
import {Errors} from "@layerzerolabs/lz-evm-protocol-v2/contracts/libs/Errors.sol";
import {SimpleMessageLib} from "@layerzerolabs/lz-evm-protocol-v2/contracts/messagelib/SimpleMessageLib.sol";
import {OmniCounter} from "@layerzerolabs/solidity-examples/contracts/examples/OmniCounter.sol";
import {TypeCasts} from "../../../contracts/libs/TypeCasts.sol";
import {StandardHookMetadata} from "../../../contracts/hooks/libs/StandardHookMetadata.sol";
import {TestMailbox} from "../../../contracts/test/TestMailbox.sol";
import {TestPostDispatchHook} from "../../../contracts/test/TestPostDispatchHook.sol";
import {TestIsm} from "../../../contracts/test/TestIsm.sol";
import {LayerZeroTreasuryMock} from "../../../contracts/test/TestLayerZeroTreasury.sol";
import {LayerZeroV2Hook, LayerZeroV2Metadata} from "../../../contracts/hooks/layer-zero/LayerZeroV2Hook.sol";
import {IPostDispatchHook} from "../../../contracts/interfaces/hooks/IPostDispatchHook.sol";

import "forge-std/console.sol";

contract LayerZeroV2HookTest is Test {
    using TypeCasts for address;

    uint32 internal localEid;
    uint32 internal remoteEid;
    EndpointV2 lZEndpointV2;
    SimpleMessageLib internal simpleMsgLib;

    OmniCounter crossChainCounterApp;
    TestMailbox public mailbox;
    TestPostDispatchHook requiredHook;
    TestIsm ism;
    LayerZeroV2Hook hook;
    address alice = makeAddr("alice");
    uint8 constant HYPERLANE_DEST_DOMAIN = 1;

    function setUp() public {
        // Set up LZ
        localEid = 1;
        remoteEid = 2;
        (lZEndpointV2, simpleMsgLib) = setupEndpointWithSimpleMsgLib(localEid);
        crossChainCounterApp = new OmniCounter(address(lZEndpointV2));
        setDefaultMsgLib(lZEndpointV2, address(simpleMsgLib), remoteEid);

        // Setup Hyperlane
        requiredHook = new TestPostDispatchHook();
        mailbox = new TestMailbox(HYPERLANE_DEST_DOMAIN);
        ism = new TestIsm();
        hook = new LayerZeroV2Hook(
            address(mailbox),
            HYPERLANE_DEST_DOMAIN,
            address(ism).addressToBytes32(),
            address(lZEndpointV2)
        );

        mailbox.setRequiredHook(address(requiredHook));
    }

    function setUpEndpoint(uint32 _eid) public returns (EndpointV2) {
        return new EndpointV2(_eid, address(this));
    }

    function setupEndpointWithSimpleMsgLib(
        uint32 _eid
    ) public returns (EndpointV2, SimpleMessageLib) {
        EndpointV2 e = setUpEndpoint(_eid);

        LayerZeroTreasuryMock treasuryMock = new LayerZeroTreasuryMock();
        SimpleMessageLib msgLib = new SimpleMessageLib(
            address(e),
            address(treasuryMock)
        );

        // register msg lib
        e.registerLibrary(address(msgLib));

        return (e, msgLib);
    }

    function setDefaultMsgLib(
        EndpointV2 _endpoint,
        address _msglib,
        uint32 _remoteEid
    ) public {
        _endpoint.setDefaultSendLibrary(_remoteEid, _msglib);
        _endpoint.setDefaultReceiveLibrary(_remoteEid, _msglib, 0);
    }

    function testLzV2Hook_ParseLzMetadata_returnsCorrectData() public {
        // format Lz metadata
        address refundAddress = alice;
        bytes memory options = "options";
        LayerZeroV2Metadata memory layerZeroMetadata = LayerZeroV2Metadata(
            remoteEid,
            refundAddress,
            options
        );
        bytes memory formattedMetadata = hook.formatLzMetadata(
            layerZeroMetadata
        );

        (uint32 eid, address _refundAddress, bytes memory _options) = hook
            .parseLzMetadata(formattedMetadata);
        assertEq(eid, remoteEid);
        assertEq(_refundAddress, refundAddress);
        assertEq(_options, options);
    }

    function testLzV2Hook_QuoteDispatch_returnsFeeAmount()
        public
        returns (uint256 nativeFee, bytes memory metadata)
    {
        // Build metadata to include LZ-specific data
        address refundAddress = alice;
        bytes memory payload = "Hello World!";
        bytes memory options = "options";
        LayerZeroV2Metadata memory layerZeroV2Metadata = LayerZeroV2Metadata(
            remoteEid,
            refundAddress,
            options
        );
        bytes memory formattedLzMetadata = hook.formatLzMetadata(
            layerZeroV2Metadata
        );
        metadata = StandardHookMetadata.formatMetadata(
            0,
            0,
            refundAddress,
            formattedLzMetadata
        );
        bytes memory message = mailbox.buildOutboundMessage(
            HYPERLANE_DEST_DOMAIN,
            address(lZEndpointV2).addressToBytes32(),
            payload
        );
        nativeFee = hook.quoteDispatch(metadata, message);

        // It costs something
        assertGt(nativeFee, 0);
    }

    function testLzV2Hook_PostDispatch_notEnoughFee(uint256 balance) public {
        (
            uint256 nativeFee,
            bytes memory metadata
        ) = testLzV2Hook_QuoteDispatch_returnsFeeAmount();

        vm.assume(balance < nativeFee - 1);

        vm.deal(address(this), balance);
        vm.expectRevert(); // OutOfFunds
        mailbox.dispatch{value: balance}(
            HYPERLANE_DEST_DOMAIN,
            address(crossChainCounterApp).addressToBytes32(),
            "Hello World!",
            metadata,
            hook
        );
    }

    function testLzV2Hook_PostDispatch_refundExtraFee(uint256 balance) public {
        (
            uint256 nativeFee,
            bytes memory metadata
        ) = testLzV2Hook_QuoteDispatch_returnsFeeAmount();
        vm.assume(balance > nativeFee);

        uint256 extraValue = balance - nativeFee;
        vm.deal(address(this), balance);

        mailbox.dispatch{value: balance}(
            HYPERLANE_DEST_DOMAIN,
            address(crossChainCounterApp).addressToBytes32(),
            "Hello World!",
            metadata,
            hook
        );
        assertEq(address(alice).balance, extraValue);
    }

    function testLzV2Hook_PostDispatch_executesCrossChain() public {
        (
            uint256 nativeFee,
            bytes memory metadata
        ) = testLzV2Hook_QuoteDispatch_returnsFeeAmount();

        mailbox.dispatch{value: nativeFee}(
            HYPERLANE_DEST_DOMAIN,
            address(crossChainCounterApp).addressToBytes32(),
            "Hello World!",
            metadata,
            hook
        );
    }

    // TODO test failed/retry
    function testLzV2Hook_HookType() public {
        assertEq(hook.hookType(), uint8(IPostDispatchHook.Types.ID_AUTH_ISM));
    }
}
