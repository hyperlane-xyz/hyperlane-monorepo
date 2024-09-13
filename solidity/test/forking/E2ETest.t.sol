// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {HyperlaneForkTest} from "../../contracts/test/HyperlaneForkTest.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";
import {TestIsm} from "../../contracts/test/TestIsm.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {IMailbox} from "../../contracts/interfaces/IMailbox.sol";

contract E2ETest is HyperlaneForkTest {
    using TypeCasts for address;

    uint32 mainnetDomain = 1;
    uint32 polygonPosDomain = 137;

    IMailbox mainnetMailbox =
        IMailbox(0xc005dc82818d67AF737725bD4bf75435d065D239);
    IMailbox polygonPosMailbox =
        IMailbox(0x5d934f4e2f797775e53561bB72aca21ba36B96BB);

    TestRecipient mainnetRecipient;
    TestRecipient polygonPosRecipient;

    uint256 internal mainnetFork;
    uint256 internal polygonPosFork;

    function setUp() public {
        mainnetFork = vm.createFork(vm.rpcUrl("mainnet"), 18_718_401);
        polygonPosFork = vm.createFork(vm.rpcUrl("polygon"), 50_760_479);

        setUpMailbox(mainnetFork);
        mainnetRecipient = new TestRecipient();

        setUpMailbox(polygonPosFork);
        polygonPosRecipient = new TestRecipient();
    }

    /// @notice Workspace dependencies are hoisted to the monorepo node_modules so we need to
    ///         override the registry location. Most projects will just use the default.
    function _registryUri() internal view override returns (string memory) {
        return
            string.concat(
                vm.projectRoot(),
                "/../node_modules/@hyperlane-xyz/registry"
            );
    }

    function testSendMessageL1ToL2() public {
        string memory _message = "Aloha from L1!";
        vm.selectFork(mainnetFork);
        mainnetMailbox.dispatch(
            polygonPosDomain,
            address(polygonPosRecipient).addressToBytes32(),
            bytes(_message)
        );
        processNextInboundMessage();
        assertEq(string(polygonPosRecipient.lastData()), _message);
    }

    function testSendMessageL2ToL1() public {
        string memory _message = "Aloha from L2!";
        vm.selectFork(polygonPosFork);
        polygonPosMailbox.dispatch(
            mainnetDomain,
            address(mainnetRecipient).addressToBytes32(),
            bytes(_message)
        );
        processNextInboundMessage();
        assertEq(string(mainnetRecipient.lastData()), _message);
    }

    function testMailboxDefaultIsmMocking() public {
        mockDefaultIsm(mainnetDomain, false);

        string memory _message = "Aloha from L2!";
        vm.selectFork(polygonPosFork);
        polygonPosMailbox.dispatch(
            mainnetDomain,
            address(mainnetRecipient).addressToBytes32(),
            bytes(_message)
        );
        vm.expectRevert("Mailbox: ISM verification failed");
        processNextInboundMessage();
    }

    function testRecipientIsmMocking() public {
        vm.selectFork(mainnetFork);
        mainnetRecipient.setInterchainSecurityModule(address(new TestIsm()));
        mockRecipientIsm(mainnetDomain, mainnetRecipient, false);

        string memory _message = "Aloha from L2!";
        vm.selectFork(polygonPosFork);
        polygonPosMailbox.dispatch(
            mainnetDomain,
            address(mainnetRecipient).addressToBytes32(),
            bytes(_message)
        );
        vm.expectRevert("Mailbox: ISM verification failed");
        processNextInboundMessage();
    }
}
