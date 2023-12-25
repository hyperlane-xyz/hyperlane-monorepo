// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {LZEndpointMock} from "@layerzerolabs/solidity-examples/contracts/lzApp/mocks/LZEndpointMock.sol";
import {OmniCounter} from "@layerzerolabs/solidity-examples/contracts/examples/OmniCounter.sol";

import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {LayerZeroHook, LayerZeroMetadata} from "../../contracts/hooks/LayerZeroHook.sol";
import {IPostDispatchHook} from "../../contracts/interfaces/hooks/IPostDispatchHook.sol";

contract LayerZeroHookTest is Test {
    OmniCounter crossChainCounterApp;
    LZEndpointMock lZEndpointMock;
    TestMailbox public mailbox;
    TestPostDispatchHook requiredHook;
    LayerZeroHook hook;

    function setUp() public {
        lZEndpointMock = new LZEndpointMock(uint16(block.chainid));
        crossChainCounterApp = new OmniCounter(address(lZEndpointMock));
        requiredHook = new TestPostDispatchHook();
        mailbox = new TestMailbox(0);
        hook = new LayerZeroHook(address(mailbox), address(lZEndpointMock));

        mailbox.setRequiredHook(address(requiredHook));

        // Sets the endpoint destinations
        lZEndpointMock.setDestLzEndpoint(
            address(crossChainCounterApp),
            address(lZEndpointMock)
        );

        // set hook as a trusted remote
        crossChainCounterApp.setTrustedRemote(
            uint16(block.chainid),
            abi.encodePacked(address(hook), address(crossChainCounterApp))
        );
    }

    function testParseLzMetadata_returnsCorrectData() public {
        // format metadata
        uint16 dstChainId = uint16(block.chainid);
        address userApplication = makeAddr("user app");
        address refundAddress = address(this);
        bytes memory payload = "";
        bytes memory destination = "";
        bytes memory adapterParam = "";
        LayerZeroMetadata memory layerZeroMetadata = LayerZeroMetadata(
            dstChainId,
            userApplication,
            refundAddress,
            payload,
            destination,
            adapterParam
        );
        bytes memory formattedMetadata = hook.formatLzMetadata(
            layerZeroMetadata
        );

        (
            uint16 _dstChainId,
            address _userApplication,
            address _refundAddress,
            bytes memory _payload,
            bytes memory _destination,
            bytes memory _adapterParam
        ) = hook.parseLzMetadata(formattedMetadata);
        assertEq(_dstChainId, dstChainId);
        assertEq(_userApplication, userApplication);
        assertEq(_refundAddress, refundAddress);
        assertEq(_payload, payload);
        assertEq(_destination, destination);
        assertEq(_adapterParam, adapterParam);
    }

    function testQuoteDispatch_returnsFeeAmount()
        public
        returns (uint256 nativeFee, bytes memory metadata)
    {
        // Build metadata to include LZ-specific data
        // format metadata
        uint16 dstChainId = uint16(block.chainid);
        address userApplication = makeAddr("user app");
        address refundAddress = address(this);
        bytes memory payload = "";
        bytes memory destination = abi.encodePacked(
            address(crossChainCounterApp),
            address(lZEndpointMock)
        ); // remoteAndLocalAddresses
        bytes memory adapterParam = "";
        LayerZeroMetadata memory layerZeroMetadata = LayerZeroMetadata(
            dstChainId,
            userApplication,
            refundAddress,
            payload,
            destination,
            adapterParam
        );
        bytes memory formattedLzMetadata = hook.formatLzMetadata(
            layerZeroMetadata
        );
        metadata = StandardHookMetadata.formatMetadata(
            0,
            0,
            refundAddress,
            formattedLzMetadata
        );

        nativeFee = hook.quoteDispatch(metadata, "");
        // It costs something
        assertGt(nativeFee, 0);
    }

    function testPostDispatch_executesCrossChain() public {
        (
            uint256 nativeFee,
            bytes memory metadata
        ) = testQuoteDispatch_returnsFeeAmount();

        // dispatch also executes L0 call to increment counter
        assertEq(crossChainCounterApp.counter(), 0);
        mailbox.dispatch{value: nativeFee}(0, "", "", metadata, hook);
        assertEq(crossChainCounterApp.counter(), 1);
    }

    function testHookType() public {
        assertEq(hook.hookType(), uint8(IPostDispatchHook.Types.LAYER_ZERO));
    }
}
