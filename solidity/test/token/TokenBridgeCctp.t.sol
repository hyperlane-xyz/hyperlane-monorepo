// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/Test.sol";
import "forge-std/StdCheats.sol";

import {MockToken} from "../../contracts/mock/MockToken.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {TokenBridgeCctp} from "../../contracts/token/TokenBridgeCctp.sol";
import {MockHyperlaneEnvironment} from "../../contracts/mock/MockHyperlaneEnvironment.sol";
import {MockCircleMessageTransmitter} from "../../contracts/mock/MockCircleMessageTransmitter.sol";
import {MockCircleTokenMessenger, MockCircleTokenMessengerV2} from "../../contracts/mock/MockCircleTokenMessenger.sol";
import {TestInterchainGasPaymaster} from "../../contracts/test/TestInterchainGasPaymaster.sol";
import {MockMailbox} from "../../contracts/mock/MockMailbox.sol";
import {Quote} from "../../contracts/interfaces/ITokenBridge.sol";
import {ICcipReadIsm} from "../../contracts/interfaces/isms/ICcipReadIsm.sol";
import {IMessageTransmitter} from "../../contracts/interfaces/cctp/IMessageTransmitter.sol";
import {ITokenMessenger} from "../../contracts/interfaces/cctp/ITokenMessenger.sol";
import {ITokenMessengerV2} from "../../contracts/interfaces/cctp/ITokenMessengerV2.sol";
import {TokenRouter} from "../../contracts/token/libs/TokenRouter.sol";
import {ITransparentUpgradeableProxy, TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {CctpMessage, BurnMessage} from "../../contracts/libs/CctpMessage.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {CctpService} from "../../contracts/token/TokenBridgeCctp.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";
import {IMessageTransmitter} from "../../contracts/interfaces/cctp/IMessageTransmitter.sol";
import {IMailbox} from "../../contracts/interfaces/IMailbox.sol";
import {ISpecifiesInterchainSecurityModule} from "../../contracts/interfaces/IInterchainSecurityModule.sol";

contract TokenBridgeCctpTest is Test {
    using TypeCasts for address;
    using TypeCasts for bytes32;
    using Message for bytes;

    uint32 internal constant CCTP_VERSION_1 = 0;
    uint32 internal constant CCTP_VERSION_2 = 1;

    uint256 internal constant scale = 1;
    uint32 internal constant origin = 1;
    uint32 internal constant destination = 2;
    uint32 internal constant cctpOrigin = 0;
    uint32 internal constant cctpDestination = 2;
    uint256 internal constant gasLimit = 250_000;

    TestInterchainGasPaymaster internal igpOrigin;
    TestInterchainGasPaymaster internal igpDestination;
    TokenBridgeCctp internal tbOrigin;
    TokenBridgeCctp internal tbDestination;

    address internal proxyAdmin;
    address internal evil = makeAddr("evil");
    string[] internal urls;

    MockToken internal tokenOrigin;
    MockToken internal tokenDestination;

    uint32 internal version = 0; // CCTPv1
    uint256 internal amount = 1_000_000; // 1 USDC
    address internal user = address(11);
    uint256 internal balance = 10_000_000; // 10 USDC

    MockMailbox internal mailboxOrigin;
    MockMailbox internal mailboxDestination;
    MockHyperlaneEnvironment internal environment;
    MockCircleTokenMessenger internal tokenMessengerOrigin;
    MockCircleMessageTransmitter internal messageTransmitterOrigin;
    MockCircleTokenMessenger internal tokenMessengerDestination;
    MockCircleMessageTransmitter internal messageTransmitterDestination;

    function _getUrls() internal returns (string[] memory) {
        string[] memory urls = new string[](1);
        urls[0] = "https://ccip-read-gateway.io";
        return urls;
    }

    function setUp() public virtual {
        proxyAdmin = makeAddr("proxyAdmin");

        environment = new MockHyperlaneEnvironment(origin, destination);
        mailboxOrigin = environment.mailboxes(origin);
        mailboxDestination = environment.mailboxes(destination);

        igpOrigin = new TestInterchainGasPaymaster();
        igpDestination = new TestInterchainGasPaymaster();

        mailboxOrigin.setDefaultHook(address(igpOrigin));
        mailboxOrigin.setDefaultHook(address(igpDestination));

        tokenOrigin = new MockToken();
        tokenDestination = new MockToken();

        tokenOrigin.mint(user, balance);

        messageTransmitterOrigin = new MockCircleMessageTransmitter(
            tokenOrigin
        );
        tokenMessengerOrigin = new MockCircleTokenMessenger(tokenOrigin);

        messageTransmitterDestination = new MockCircleMessageTransmitter(
            tokenDestination
        );
        tokenMessengerDestination = new MockCircleTokenMessenger(
            tokenDestination
        );

        TokenBridgeCctp originImplementation = new TokenBridgeCctp(
            address(tokenOrigin),
            scale,
            address(mailboxOrigin),
            IMessageTransmitter(address(messageTransmitterOrigin)),
            ITokenMessenger(address(tokenMessengerOrigin))
        );

        bytes memory initData = abi.encodeWithSignature(
            "initialize(address,address,string[])",
            address(0),
            address(this),
            _getUrls()
        );
        TransparentUpgradeableProxy proxyOrigin = new TransparentUpgradeableProxy(
                address(originImplementation),
                proxyAdmin,
                initData
            );
        tbOrigin = TokenBridgeCctp(address(proxyOrigin));

        TokenBridgeCctp destinationImplementation = new TokenBridgeCctp(
            address(tokenDestination),
            scale,
            address(mailboxDestination),
            IMessageTransmitter(address(messageTransmitterDestination)),
            ITokenMessenger(address(tokenMessengerDestination))
        );

        TransparentUpgradeableProxy proxyDestination = new TransparentUpgradeableProxy(
                address(destinationImplementation),
                proxyAdmin,
                initData
            );

        tbDestination = TokenBridgeCctp(address(proxyDestination));

        _setupTokenBridgesCctp(tbOrigin, tbDestination);

        vm.deal(user, 1 ether);
    }

    function _encodeCctpBurnMessage(
        uint64 nonce,
        uint32 sourceDomain,
        bytes32 recipient,
        uint256 amount
    ) internal view returns (bytes memory) {
        return
            _encodeCctpBurnMessage(
                nonce,
                sourceDomain,
                recipient,
                amount,
                address(tbOrigin)
            );
    }

    function _encodeCctpBurnMessage(
        uint64 nonce,
        uint32 sourceDomain,
        bytes32 recipient,
        uint256 amount,
        address sender
    ) internal view returns (bytes memory) {
        bytes memory burnMessage = BurnMessage._formatMessage(
            version,
            address(tokenOrigin).addressToBytes32(),
            recipient,
            amount,
            sender.addressToBytes32()
        );
        return
            CctpMessage._formatMessage(
                version,
                sourceDomain,
                cctpDestination,
                nonce,
                address(tokenMessengerOrigin).addressToBytes32(),
                address(tokenMessengerDestination).addressToBytes32(),
                bytes32(0),
                burnMessage
            );
    }

    function _setupAndDispatch()
        internal
        returns (bytes memory message, uint64 cctpNonce, bytes32 recipient)
    {
        recipient = user.addressToBytes32();
        Quote[] memory quote = tbOrigin.quoteTransferRemote(
            destination,
            recipient,
            amount
        );

        vm.startPrank(user);
        tokenOrigin.approve(address(tbOrigin), quote[1].amount);

        cctpNonce = tokenMessengerOrigin.nextNonce();
        tbOrigin.transferRemote{value: quote[0].amount}(
            destination,
            recipient,
            amount
        );

        message = mailboxDestination.inboundMessages(0);
    }

    function test_setUrls_revertsWhen_callerIsNotTheOwner() public {
        vm.prank(evil);
        _expectCallerIsNotTheOwnerRevert();
        tbOrigin.setUrls(_getUrls());
    }

    function test_addDomain_revertsWhen_callerIsNotTheOwner() public {
        vm.prank(evil);
        _expectCallerIsNotTheOwnerRevert();
        tbOrigin.addDomain(destination, cctpDestination);
    }

    function test_quoteTransferRemote_getCorrectQuote() public {
        Quote[] memory quotes = tbOrigin.quoteTransferRemote(
            destination,
            user.addressToBytes32(),
            amount
        );

        assertEq(quotes.length, 2);
        assertEq(quotes[0].token, address(0));
        assertEq(quotes[1].token, address(tokenOrigin));
    }

    function test_transferRemoteCctp() public {
        Quote[] memory quote = tbOrigin.quoteTransferRemote(
            destination,
            user.addressToBytes32(),
            amount
        );

        vm.startPrank(user);
        tokenOrigin.approve(address(tbOrigin), quote[1].amount);

        uint64 cctpNonce = tokenMessengerOrigin.nextNonce();

        vm.expectCall(
            address(tokenMessengerOrigin),
            abi.encodeCall(
                MockCircleTokenMessenger.depositForBurn,
                (
                    amount,
                    cctpDestination,
                    user.addressToBytes32(),
                    address(tokenOrigin)
                )
            )
        );
        tbOrigin.transferRemote{value: quote[0].amount}(
            destination,
            user.addressToBytes32(),
            amount
        );
    }

    function test_verify() public {
        (
            bytes memory message,
            uint64 cctpNonce,
            bytes32 recipient
        ) = _setupAndDispatch();

        _expectOffChainLookUpRevert(message);
        tbDestination.getOffchainVerifyInfo(message);

        bytes memory cctpMessage = _encodeCctpBurnMessage(
            cctpNonce,
            cctpOrigin,
            recipient,
            amount
        );
        bytes memory attestation = bytes("");
        bytes memory metadata = abi.encode(cctpMessage, attestation);

        vm.expectCall(
            address(messageTransmitterDestination),
            abi.encodeCall(
                MockCircleMessageTransmitter.receiveMessage,
                (cctpMessage, attestation)
            )
        );
        assertEq(tbDestination.verify(metadata, message), true);
    }

    function _upgrade(TokenBridgeCctp bridge) internal {
        TokenBridgeCctp newImplementation = new TokenBridgeCctp(
            address(bridge.wrappedToken()),
            bridge.scale(),
            address(bridge.mailbox()),
            bridge.messageTransmitter(),
            bridge.tokenMessenger()
        );

        bytes32 adminBytes = vm.load(
            address(bridge),
            bytes32(uint256(keccak256("eip1967.proxy.admin")) - 1)
        );
        address admin = address(uint160(uint256(adminBytes)));
        vm.prank(admin);
        ITransparentUpgradeableProxy(address(bridge)).upgradeTo(
            address(newImplementation)
        );
    }

    function testFork_verify() public {
        TokenBridgeCctp recipient = TokenBridgeCctp(
            0x5C4aFb7e23B1Dc1B409dc1702f89C64527b25975
        );
        vm.createSelectFork(vm.rpcUrl("base"), 32_126_535);

        bytes
            memory metadata = hex"0000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000016000000000000000000000000000000000000000000000000000000000000000f80000000000000000000000060000000000044df3000000000000000000000000bd3fa81b58ba92a82136038b25adec7066af31550000000000000000000000001682ae6375c4e4a97e4b583bc394c861a46d8962000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb480000000000000000000000001547b13bd71126d92e93092cad07807eedb6fc260000000000000000000000000000000000000000000000000000000000000001000000000000000000000000edcbaa585fd0f80f20073f9958246476466205b8000000000000000000000000000000000000000000000000000000000000000000000000000000822828b6af83fc19fc0e46a6dc4470c93e02855175de1fc77e01858eefb8bc5c9140df500f482cbfa384bd1bf6a020cdb078788ff3eff1c7ead090ae93c2088c8b1c2e143054b1656ba072ebf83c30e1ea9929043be7a8fe28c087a32a285bd6a5310e48b26b46595143ed8ee71bbc49e9deceabd69d0802331188fa69309477d80e1c000000000000000000000000000000000000000000000000000000000000";
        bytes
            memory message = hex"0300016f5200000001000000000000000000000000edcbaa585fd0f80f20073f9958246476466205b8000021050000000000000000000000005c4afb7e23b1dc1b409dc1702f89c64527b259750000000000000000000000001547b13bd71126d92e93092cad07807eedb6fc2600000000000000000000000000000000000000000000000000000000000000010000000000044df3";

        vm.expectRevert();
        recipient.verify(metadata, message);

        _upgrade(recipient);
        assertEq(recipient.verify(metadata, message), true);
    }

    function test_verify_revertsWhen_invalidNonce() public {
        (
            bytes memory message,
            uint64 cctpNonce,
            bytes32 recipient
        ) = _setupAndDispatch();

        // invalid nonce := nextNonce + 1
        uint64 badNonce = cctpNonce + 1;
        bytes memory cctpMessage = _encodeCctpBurnMessage(
            badNonce,
            cctpOrigin,
            recipient,
            amount
        );
        bytes memory attestation = bytes("");
        bytes memory metadata = abi.encode(cctpMessage, attestation);

        vm.expectRevert(bytes("Invalid nonce"));
        tbDestination.verify(metadata, message);
    }

    function test_verify_revertsWhen_invalidSourceDomain() public {
        (
            bytes memory message,
            uint64 cctpNonce,
            bytes32 recipient
        ) = _setupAndDispatch();

        // invalid source domain := destination
        uint32 badSourceDomain = cctpDestination;
        bytes memory cctpMessage = _encodeCctpBurnMessage(
            cctpNonce,
            badSourceDomain,
            recipient,
            amount
        );
        bytes memory attestation = bytes("");
        bytes memory metadata = abi.encode(cctpMessage, attestation);

        vm.expectRevert(bytes("Invalid source domain"));
        tbDestination.verify(metadata, message);
    }

    function test_verify_revertsWhen_invalidMintAmount() public {
        (
            bytes memory message,
            uint64 cctpNonce,
            bytes32 recipient
        ) = _setupAndDispatch();

        // invalid amount := amount + 1
        uint256 badAmount = amount + 1;
        bytes memory cctpMessage = _encodeCctpBurnMessage(
            cctpNonce,
            cctpOrigin,
            recipient,
            badAmount
        );
        bytes memory attestation = bytes("");
        bytes memory metadata = abi.encode(cctpMessage, attestation);

        vm.expectRevert(bytes("Invalid mint amount"));
        tbDestination.verify(metadata, message);
    }

    function test_verify_revertsWhen_invalidMintRecipient() public {
        (bytes memory message, uint64 cctpNonce, ) = _setupAndDispatch();

        // invalid recipient := evil
        bytes32 badRecipient = evil.addressToBytes32();
        bytes memory cctpMessage = _encodeCctpBurnMessage(
            cctpNonce,
            cctpOrigin,
            badRecipient,
            amount
        );
        bytes memory attestation = bytes("");
        bytes memory metadata = abi.encode(cctpMessage, attestation);

        vm.expectRevert(bytes("Invalid mint recipient"));
        tbDestination.verify(metadata, message);
    }

    function test_verify_revertsWhen_invalidBurnSender() public {
        (
            bytes memory message,
            uint64 cctpNonce,
            bytes32 recipient
        ) = _setupAndDispatch();

        // invalid sender := evil
        bytes memory cctpMessage = _encodeCctpBurnMessage(
            cctpNonce,
            cctpOrigin,
            recipient,
            amount,
            evil
        );
        bytes memory attestation = bytes("");
        bytes memory metadata = abi.encode(cctpMessage, attestation);

        vm.expectRevert(bytes("Invalid burn sender"));
        tbDestination.verify(metadata, message);
    }

    function test_verify_revertsWhen_invalidLength() public {
        (
            bytes memory message,
            uint64 cctpNonce,
            bytes32 recipient
        ) = _setupAndDispatch();

        bytes memory cctpMessage = _encodeCctpBurnMessage(
            cctpNonce,
            cctpOrigin,
            recipient,
            amount
        );
        bytes memory attestation = bytes("");
        bytes memory metadata = abi.encode(cctpMessage, attestation);

        // a message with invalid length.
        bytes memory badMessage = bytes.concat(message, bytes1(uint8(60)));

        vm.expectRevert();
        tbDestination.verify(metadata, badMessage);
    }

    function test_revertsWhen_versionIsNotSupported() public virtual {
        messageTransmitterOrigin.setVersion(CCTP_VERSION_1);
        MockCircleTokenMessengerV2 tokenMessengerV2 = new MockCircleTokenMessengerV2(
                tokenOrigin
            );

        vm.expectRevert(bytes("Invalid TokenMessenger CCTP version"));
        TokenBridgeCctp v1 = new TokenBridgeCctp(
            address(tokenOrigin),
            scale,
            address(mailboxOrigin),
            IMessageTransmitter(address(messageTransmitterOrigin)),
            ITokenMessenger(address(tokenMessengerV2))
        );

        messageTransmitterOrigin.setVersion(CCTP_VERSION_2);

        vm.expectRevert(bytes("Invalid messageTransmitter CCTP version"));
        v1 = new TokenBridgeCctp(
            address(tokenOrigin),
            scale,
            address(mailboxOrigin),
            IMessageTransmitter(address(messageTransmitterOrigin)),
            ITokenMessenger(address(tokenMessengerOrigin))
        );
    }

    function _expectOffChainLookUpRevert(bytes memory message) internal {
        vm.expectRevert(
            abi.encodeWithSelector(
                ICcipReadIsm.OffchainLookup.selector,
                address(tbDestination),
                _getUrls(),
                abi.encodeCall(CctpService.getCCTPAttestation, (message)),
                tbDestination.verify.selector,
                message
            )
        );
    }

    function _expectCallerIsNotTheOwnerRevert() internal {
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
    }

    function _setupTokenBridgesCctp(
        TokenBridgeCctp _tbOrigin,
        TokenBridgeCctp _tbDestination
    ) internal {
        _tbOrigin.setUrls(_getUrls());
        _tbOrigin.addDomain(destination, cctpDestination);
        _tbOrigin.enrollRemoteRouter(
            destination,
            address(_tbDestination).addressToBytes32()
        );
        _tbOrigin.setDestinationGas(destination, gasLimit);

        _tbDestination.setUrls(_getUrls());
        _tbDestination.addDomain(origin, cctpOrigin);
        _tbDestination.enrollRemoteRouter(
            origin,
            address(_tbOrigin).addressToBytes32()
        );
        _tbDestination.setDestinationGas(origin, gasLimit);
    }

    function test_hyperlaneDomainToCircleDomain(
        uint32 unconfiguredHyperlaneDomain,
        uint32 circleDomain
    ) public {
        // Assumptions for fuzzing: ensure the domain is truly unconfigured and not zero.
        vm.assume(unconfiguredHyperlaneDomain != 0);
        vm.assume(unconfiguredHyperlaneDomain != origin);
        vm.assume(unconfiguredHyperlaneDomain != destination);

        vm.expectRevert(bytes("Circle domain not configured"));
        tbOrigin.hyperlaneDomainToCircleDomain(unconfiguredHyperlaneDomain);

        // covers the case where circleDomain is 0
        tbOrigin.addDomain(unconfiguredHyperlaneDomain, circleDomain);
        assertEq(
            tbOrigin.hyperlaneDomainToCircleDomain(unconfiguredHyperlaneDomain),
            circleDomain
        );
    }

    function test_postDispatch(bytes32 recipient, bytes calldata body) public {
        // precompute message ID
        bytes32 id = Message.id(
            Message.formatMessage(
                3,
                0,
                origin,
                address(this).addressToBytes32(),
                destination,
                recipient,
                body
            )
        );

        vm.expectCall(
            address(messageTransmitterOrigin),
            abi.encodeCall(
                MockCircleMessageTransmitter.sendMessageWithCaller,
                (
                    cctpDestination,
                    address(tbDestination).addressToBytes32(),
                    address(tbDestination).addressToBytes32(),
                    abi.encode(id)
                )
            )
        );
        bytes32 actualId = mailboxOrigin.dispatch(
            destination,
            recipient,
            body,
            bytes(""),
            tbOrigin
        );
        assertEq(actualId, id);
    }

    function testFork_postDispatch(
        bytes32 recipient,
        bytes calldata body
    ) public {
        vm.createSelectFork(vm.rpcUrl("base"), 32_739_842);
        TokenBridgeCctp hook = TokenBridgeCctp(
            0x5C4aFb7e23B1Dc1B409dc1702f89C64527b25975
        );
        _upgrade(hook);

        IMailbox mailbox = hook.mailbox();
        uint32 destination = 1; // ethereum
        uint32 origin = mailbox.localDomain();
        bytes32 router = hook.routers(destination);

        // precompute message ID
        bytes memory message = Message.formatMessage(
            3,
            mailbox.nonce(),
            origin,
            address(this).addressToBytes32(),
            destination,
            recipient,
            body
        );

        bytes memory cctpMessage = CctpMessage._formatMessage(
            0,
            hook.messageTransmitter().localDomain(),
            hook.hyperlaneDomainToCircleDomain(destination),
            hook.messageTransmitter().nextAvailableNonce(),
            address(hook).addressToBytes32(),
            router,
            router,
            abi.encode(Message.id(message))
        );

        vm.expectEmit(
            true,
            true,
            true,
            true,
            address(hook.messageTransmitter())
        );
        emit IMessageTransmitter.MessageSent(cctpMessage);

        mailbox.dispatch(destination, recipient, body, bytes(""), hook);
    }

    function testFork_verifyDeployerMessage() public {
        vm.createSelectFork(vm.rpcUrl("base"), 32_739_842);
        TokenBridgeCctp hook = TokenBridgeCctp(
            0x5C4aFb7e23B1Dc1B409dc1702f89C64527b25975
        );
        bytes32 router = hook.routers(1);
        uint32 origin = hook.localDomain();

        // https://basescan.org/tx/0x16b2c15cff779f16ab16a279a12c45a143047e680f8ed538318c7d67eed35569
        bytes
            memory message = hex"03001661f000002105000000000000000000000000a7eccdb9be08178f896c26b7bbd8c3d4e844d9ba00000001000000000000000000000000a7eccdb9be08178f896c26b7bbd8c3d4e844d9badeadbeef";

        // https://basescan.org/tx/0x4eeffc2aa410ede620d17ae18f513bf31941d301e8ada6676b54d3300dac116a
        bytes
            memory cctpMessage = hex"0000000000000006000000000000000000096af6000000000000000000000000a7eccdb9be08178f896c26b7bbd8c3d4e844d9ba000000000000000000000000edcbaa585fd0f80f20073f9958246476466205b8000000000000000000000000edcbaa585fd0f80f20073f9958246476466205b8a331d7762c517834242bea4b027d3dcebbd32e7d312ef3dd7a9d73ced95f9adb";

        // $ curl https://iris-api.circle.com/v1/messages/6/0x4eeffc2aa410ede620d17ae18f513bf31941d301e8ada6676b54d3300dac116a
        bytes
            memory attestation = hex"4a713f6935bf2f0a9b6aa01a9a5c1c4e0da23f858193f20fde96e814e63345d85a65b6f1f53f0b22cde3c611d03a032eab7ac4c26232f3a7ff9185c69ee205ee1b614fac487343203b8c6e2c210440576fbe64e7fb70de5f4be87291187604656d19c4ebc4dc33558d36e6e799fc8adca45f8b704cf6eecf3adf7254ad88d2efd41c";
        bytes memory metadata = abi.encode(cctpMessage, attestation);

        vm.createSelectFork(vm.rpcUrl("mainnet"), 22_898_879);
        TokenBridgeCctp ism = TokenBridgeCctp(router.bytes32ToAddress());
        _upgrade(ism);

        vm.expectRevert(bytes("Invalid circle sender"));
        ism.verify(metadata, message);

        // CCTP message was manually sent from deployer on origin chain to deployer on destination chain
        address deployer = 0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba;
        vm.prank(ism.owner());
        ism.enrollRemoteRouter(origin, deployer.addressToBytes32());

        vm.mockCall(
            deployer,
            abi.encodeWithSelector(
                ISpecifiesInterchainSecurityModule
                    .interchainSecurityModule
                    .selector
            ),
            abi.encode(address(ism))
        );

        vm.expectCall(
            address(ism),
            abi.encode(TokenBridgeCctp.handleReceiveMessage.selector)
        );
        ism.mailbox().process(metadata, message);
    }

    function test_postDispatch_revertsWhen_messageNotDispatched(
        bytes32 recipient,
        bytes calldata body
    ) public {
        bytes memory message = Message.formatMessage(
            3,
            0,
            origin,
            address(this).addressToBytes32(),
            destination,
            recipient,
            body
        );
        vm.expectRevert(bytes("Message not dispatched"));
        tbOrigin.postDispatch(bytes(""), message);
    }

    function test_verify_hookMessage(bytes calldata body) public {
        TestRecipient recipient = new TestRecipient();
        recipient.setInterchainSecurityModule(address(tbDestination));

        bytes32 id = mailboxOrigin.dispatch(
            destination,
            address(recipient).addressToBytes32(),
            body,
            bytes(""),
            tbOrigin
        );

        bytes memory cctpMessage = CctpMessage._formatMessage(
            version,
            cctpOrigin,
            cctpDestination,
            tokenMessengerOrigin.nextNonce(),
            address(tbOrigin).addressToBytes32(),
            address(tbDestination).addressToBytes32(),
            bytes32(0), // destinationCaller
            abi.encode(id)
        );

        bytes memory attestation = bytes("");
        bytes memory metadata = abi.encode(cctpMessage, attestation);
        mailboxDestination.addInboundMetadata(0, metadata);

        mailboxDestination.processNextInboundMessage();

        assertEq(recipient.lastData(), body);
    }

    function test_verify_revertsWhen_invalidMessageSender(
        bytes32 recipient,
        bytes calldata body
    ) public {
        bytes memory message = Message.formatMessage(
            3,
            0,
            origin,
            address(this).addressToBytes32(),
            destination,
            recipient,
            body
        );

        bytes32 badSender = ~address(tbOrigin).addressToBytes32();

        bytes memory cctpMessage = CctpMessage._formatMessage(
            version,
            cctpOrigin,
            cctpDestination,
            tokenMessengerOrigin.nextNonce(),
            badSender,
            address(tbDestination).addressToBytes32(),
            bytes32(0), // destinationCaller
            message
        );

        bytes memory attestation = bytes("");
        bytes memory metadata = abi.encode(cctpMessage, attestation);

        vm.expectRevert(bytes("Invalid circle sender"));
        tbDestination.verify(metadata, message);
    }

    function test_verify_revertsWhen_invalidMessageId(
        bytes32 recipient,
        bytes calldata body
    ) public {
        bytes memory message = Message.formatMessage(
            3,
            0,
            origin,
            address(this).addressToBytes32(),
            destination,
            recipient,
            body
        );
        bytes32 badMessageId = ~Message.id(message);

        bytes memory cctpMessage = CctpMessage._formatMessage(
            version,
            cctpOrigin,
            cctpDestination,
            tokenMessengerOrigin.nextNonce(),
            address(tbOrigin).addressToBytes32(),
            address(tbDestination).addressToBytes32(),
            bytes32(0), // destinationCaller
            abi.encode(badMessageId)
        );

        bytes memory attestation = bytes("");
        bytes memory metadata = abi.encode(cctpMessage, attestation);

        vm.expectRevert(bytes("Invalid message id"));
        tbDestination.verify(metadata, message);
    }

    function test_verify_revertsWhen_invalidMessageRecipient(
        bytes32 recipient,
        bytes calldata body
    ) public {
        bytes memory message = Message.formatMessage(
            3,
            0,
            origin,
            address(this).addressToBytes32(),
            destination,
            recipient,
            body
        );

        address badRecipient = address(~bytes20(address(tbDestination)));

        bytes memory cctpMessage = CctpMessage._formatMessage(
            version,
            cctpOrigin,
            cctpDestination,
            tokenMessengerOrigin.nextNonce(),
            address(tbOrigin).addressToBytes32(),
            badRecipient.addressToBytes32(),
            bytes32(0), // destinationCaller
            abi.encode(Message.id(message))
        );

        bytes memory attestation = bytes("");
        bytes memory metadata = abi.encode(cctpMessage, attestation);

        vm.expectRevert(bytes("Invalid circle recipient"));
        tbDestination.verify(metadata, message);
    }
}
