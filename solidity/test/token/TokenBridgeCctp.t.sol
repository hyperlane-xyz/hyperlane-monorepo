// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/Test.sol";
import "forge-std/StdCheats.sol";

import {MockToken} from "../../contracts/mock/MockToken.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {TokenBridgeCctpV1} from "../../contracts/token/TokenBridgeCctpV1.sol";
import {TokenBridgeCctpV2} from "../../contracts/token/TokenBridgeCctpV2.sol";
import {MockHyperlaneEnvironment} from "../../contracts/mock/MockHyperlaneEnvironment.sol";
import {MockCircleMessageTransmitter} from "../../contracts/mock/MockCircleMessageTransmitter.sol";
import {MockCircleTokenMessenger} from "../../contracts/mock/MockCircleTokenMessenger.sol";
import {TestInterchainGasPaymaster} from "../../contracts/test/TestInterchainGasPaymaster.sol";
import {MockMailbox} from "../../contracts/mock/MockMailbox.sol";
import {Quote} from "../../contracts/interfaces/ITokenBridge.sol";
import {ICcipReadIsm} from "../../contracts/interfaces/isms/ICcipReadIsm.sol";
import {IMessageTransmitter, IRelayer} from "../../contracts/interfaces/cctp/IMessageTransmitter.sol";
import {IMessageTransmitterV2, IRelayerV2} from "../../contracts/interfaces/cctp/IMessageTransmitterV2.sol";
import {ITokenMessenger, ITokenMessengerV1} from "../../contracts/interfaces/cctp/ITokenMessenger.sol";
import {ITokenMessengerV2} from "../../contracts/interfaces/cctp/ITokenMessengerV2.sol";
import {TokenRouter} from "../../contracts/token/libs/TokenRouter.sol";
import {ITransparentUpgradeableProxy, TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {CctpMessageV1, BurnMessageV1} from "../../contracts/libs/CctpMessageV1.sol";
import {CctpMessageV2, BurnMessageV2} from "../../contracts/libs/CctpMessageV2.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {TokenMessage} from "../../contracts/token/libs/TokenMessage.sol";
import {CctpService} from "../../contracts/token/TokenBridgeCctpBase.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";
import {TokenBridgeCctpBase} from "../../contracts/token/TokenBridgeCctpBase.sol";
import {IMessageTransmitter} from "../../contracts/interfaces/cctp/IMessageTransmitter.sol";
import {IMailbox} from "../../contracts/interfaces/IMailbox.sol";
import {ISpecifiesInterchainSecurityModule} from "../../contracts/interfaces/IInterchainSecurityModule.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LinearFee} from "../../contracts/token/fees/LinearFee.sol";
import {IPostDispatchHook} from "../../contracts/interfaces/hooks/IPostDispatchHook.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

contract TokenBridgeCctpV1Test is Test {
    using TypeCasts for address;
    using TypeCasts for bytes32;
    using Message for bytes;

    uint32 internal constant CCTP_VERSION_1 = 0;
    uint32 internal constant CCTP_VERSION_2 = 1;

    uint32 internal constant origin = 1;
    uint32 internal constant destination = 2;
    uint32 internal constant cctpOrigin = 0;
    uint32 internal constant cctpDestination = 2;
    uint256 internal constant gasLimit = 250_000;

    TestInterchainGasPaymaster internal igpOrigin;
    TestInterchainGasPaymaster internal igpDestination;
    TokenBridgeCctpBase internal tbOrigin;
    TokenBridgeCctpBase internal tbDestination;

    address internal proxyAdmin;
    address internal evil = makeAddr("evil");
    string[] internal urls;

    MockToken internal tokenOrigin;
    MockToken internal tokenDestination;

    uint32 internal version = CCTP_VERSION_1;
    uint256 internal amount = 100_010; // 1 USDC
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

        TokenBridgeCctpV1 originImplementation = new TokenBridgeCctpV1(
            address(tokenOrigin),
            address(mailboxOrigin),
            messageTransmitterOrigin,
            tokenMessengerOrigin
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
        tbOrigin = TokenBridgeCctpV1(address(proxyOrigin));

        TokenBridgeCctpV1 destinationImplementation = new TokenBridgeCctpV1(
            address(tokenDestination),
            address(mailboxDestination),
            messageTransmitterDestination,
            tokenMessengerDestination
        );

        TransparentUpgradeableProxy proxyDestination = new TransparentUpgradeableProxy(
                address(destinationImplementation),
                proxyAdmin,
                initData
            );

        tbDestination = TokenBridgeCctpV1(address(proxyDestination));

        _setupTokenBridgesCctp(tbOrigin, tbDestination);

        vm.deal(user, 1 ether);
    }

    function _encodeCctpBurnMessage(
        uint64 nonce,
        uint32 sourceDomain,
        bytes32 recipient,
        uint256 amount
    ) internal view virtual returns (bytes memory) {
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
    ) internal view virtual returns (bytes memory) {
        bytes memory burnMessage = BurnMessageV1._formatMessage(
            version,
            address(tokenOrigin).addressToBytes32(),
            recipient,
            amount,
            sender.addressToBytes32()
        );
        return
            CctpMessageV1._formatMessage(
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

    function _encodeCctpHookMessage(
        bytes32 sender,
        bytes32 recipient,
        bytes memory message
    ) internal view virtual returns (bytes memory) {
        return
            CctpMessageV1._formatMessage(
                version,
                cctpOrigin,
                cctpDestination,
                tokenMessengerOrigin.nextNonce(),
                sender,
                recipient,
                bytes32(0), // destinationCaller
                message
            );
    }

    function _encodeCctpHookMessage(
        bytes memory message
    ) internal view returns (bytes memory) {
        return
            _encodeCctpHookMessage(
                address(tbOrigin).addressToBytes32(),
                address(tbDestination).addressToBytes32(),
                message
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
        // approve internal and external fees
        tokenOrigin.approve(
            address(tbOrigin),
            quote[1].amount + quote[2].amount
        );

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

    function test_quoteTransferRemote_getCorrectQuote() public virtual {
        Quote[] memory quotes = tbOrigin.quoteTransferRemote(
            destination,
            user.addressToBytes32(),
            amount
        );

        assertEq(quotes.length, 3);
        assertEq(quotes[0].token, address(0));
        assertEq(
            quotes[0].amount,
            igpOrigin.quoteGasPayment(destination, gasLimit)
        );
        assertEq(quotes[1].token, address(tokenOrigin));
        assertEq(quotes[1].amount, amount);
        // external fee
        assertEq(quotes[2].token, address(tokenOrigin));
        assertEq(quotes[2].amount, 0);
    }

    function test_transferRemoteCctp() public virtual {
        Quote[] memory quotes = tbOrigin.quoteTransferRemote(
            destination,
            user.addressToBytes32(),
            amount
        );

        uint256 charge = quotes[1].amount + quotes[2].amount;

        vm.startPrank(user);
        tokenOrigin.approve(address(tbOrigin), charge);

        uint64 cctpNonce = tokenMessengerOrigin.nextNonce();

        vm.expectCall(
            address(tokenMessengerOrigin),
            abi.encodeCall(
                ITokenMessengerV1.depositForBurn,
                (
                    charge,
                    cctpDestination,
                    user.addressToBytes32(),
                    address(tokenOrigin)
                )
            )
        );
        tbOrigin.transferRemote{value: quotes[0].amount}(
            destination,
            user.addressToBytes32(),
            amount
        );
    }

    function test_transferRemoteCctp_withFeeRecipient() public virtual {
        LinearFee feeContract = new LinearFee(
            address(tokenOrigin),
            1e6,
            amount / 2,
            address(this)
        );
        tbOrigin.setFeeRecipient(address(feeContract));
        uint256 feeRecipientFee = feeContract
        .quoteTransferRemote(destination, user.addressToBytes32(), amount)[0]
            .amount;

        Quote[] memory quotes = tbOrigin.quoteTransferRemote(
            destination,
            user.addressToBytes32(),
            amount
        );

        uint256 charge = quotes[1].amount + quotes[2].amount;

        vm.startPrank(user);
        tokenOrigin.approve(address(tbOrigin), charge);

        uint256 initialUserBalance = tokenOrigin.balanceOf(user);
        uint256 initialFeeContractBalance = tokenOrigin.balanceOf(
            address(feeContract)
        );
        uint256 initialBridgeBalance = tokenOrigin.balanceOf(address(tbOrigin));

        uint64 cctpNonce = tokenMessengerOrigin.nextNonce();

        vm.expectCall(
            address(tokenMessengerOrigin),
            abi.encodeCall(
                ITokenMessengerV1.depositForBurn,
                (
                    charge - feeRecipientFee,
                    cctpDestination,
                    user.addressToBytes32(),
                    address(tokenOrigin)
                )
            )
        );
        tbOrigin.transferRemote{value: quotes[0].amount}(
            destination,
            user.addressToBytes32(),
            amount
        );

        // Verify fee recipient received the fee (tests the fix!)
        assertEq(
            tokenOrigin.balanceOf(address(feeContract)),
            initialFeeContractBalance + feeRecipientFee,
            "Fee contract should receive fee"
        );

        // Verify user was charged correctly
        assertEq(
            tokenOrigin.balanceOf(user),
            initialUserBalance - charge,
            "User should be charged transfer amount + fees"
        );

        // Verify bridge doesn't hold the fee
        assertEq(
            tokenOrigin.balanceOf(address(tbOrigin)),
            initialBridgeBalance,
            "Bridge should not hold fee recipient fee"
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

    function _upgrade(TokenBridgeCctpBase bridge) internal virtual {
        TokenBridgeCctpV1 newImplementation = new TokenBridgeCctpV1(
            address(bridge.wrappedToken()),
            address(bridge.mailbox()),
            bridge.messageTransmitter(),
            ITokenMessengerV1(address(bridge.tokenMessenger()))
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

    function testFork_verify_upgrade() public virtual {
        TokenBridgeCctpV1 recipient = TokenBridgeCctpV1(
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

        assert(recipient.verify(metadata, message));
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

        vm.expectRevert(TokenBridgeCctpBase.InvalidMintAmount.selector);
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

        vm.expectRevert(TokenBridgeCctpBase.InvalidMintRecipient.selector);
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

        vm.expectRevert(TokenBridgeCctpBase.InvalidBurnSender.selector);
        tbDestination.verify(metadata, message);
    }

    function test_verify_revertsWhen_invalidTokenMessageRecipient() public {
        TestRecipient messageRecipient = new TestRecipient();
        messageRecipient.setInterchainSecurityModule(address(tbDestination));

        bytes32 tokenRecipient = user.addressToBytes32();
        bytes memory messageBody = TokenMessage.format(tokenRecipient, amount);

        // Create a message with recipient instead of tbDestination
        bytes memory invalidMessage = abi.encodePacked(
            uint8(3),
            uint32(0),
            origin,
            address(tbOrigin).addressToBytes32(),
            destination,
            address(messageRecipient).addressToBytes32(),
            messageBody
        );

        bytes memory cctpMessage = _encodeCctpBurnMessage(
            0,
            cctpOrigin,
            tokenRecipient,
            amount
        );
        bytes memory attestation = bytes("");
        bytes memory metadata = abi.encode(cctpMessage, attestation);

        vm.expectRevert(
            TokenBridgeCctpBase.InvalidTokenMessageRecipient.selector
        );
        tbDestination.verify(metadata, invalidMessage);

        vm.expectRevert(
            TokenBridgeCctpBase.InvalidTokenMessageRecipient.selector
        );
        mailboxDestination.process(metadata, invalidMessage);
    }

    function test_revertsWhen_versionIsNotSupported() public virtual {
        tokenMessengerOrigin.setVersion(CCTP_VERSION_2);

        vm.expectRevert(TokenBridgeCctpBase.InvalidCCTPVersion.selector);
        TokenBridgeCctpV1 v1 = new TokenBridgeCctpV1(
            address(tokenOrigin),
            address(mailboxOrigin),
            messageTransmitterOrigin,
            tokenMessengerOrigin
        );

        messageTransmitterOrigin.setVersion(CCTP_VERSION_2);
        vm.expectRevert(TokenBridgeCctpBase.InvalidCCTPVersion.selector);
        v1 = new TokenBridgeCctpV1(
            address(tokenOrigin),
            address(mailboxOrigin),
            messageTransmitterOrigin,
            tokenMessengerOrigin
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
        TokenBridgeCctpBase _tbOrigin,
        TokenBridgeCctpBase _tbDestination
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

        vm.expectRevert(TokenBridgeCctpBase.CircleDomainNotConfigured.selector);
        tbOrigin.hyperlaneDomainToCircleDomain(unconfiguredHyperlaneDomain);

        // covers the case where circleDomain is 0
        tbOrigin.addDomain(unconfiguredHyperlaneDomain, circleDomain);
        assertEq(
            tbOrigin.hyperlaneDomainToCircleDomain(unconfiguredHyperlaneDomain),
            circleDomain
        );
    }

    function test_postDispatch(
        bytes32 recipient,
        bytes calldata body
    ) public virtual {
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
                IRelayer.sendMessage,
                (
                    cctpDestination,
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

    // needed for hook refunds
    receive() external payable {}

    function testFork_postDispatch(
        bytes32 recipient,
        bytes calldata body
    ) public virtual {
        vm.createSelectFork(vm.rpcUrl("base"), 32_739_842);
        TokenBridgeCctpV1 hook = TokenBridgeCctpV1(
            0x5C4aFb7e23B1Dc1B409dc1702f89C64527b25975
        );
        _upgrade(hook);

        IMailbox mailbox = hook.mailbox();
        uint32 destination = 1; // ethereum
        uint32 origin = mailbox.localDomain();
        bytes32 router = hook.routers(destination);

        // Ensure domain mapping exists
        uint32 circleDestination = 0; // ethereum circle domain
        vm.prank(hook.owner());
        hook.addDomain(destination, circleDestination);

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

        bytes memory cctpMessage = CctpMessageV1._formatMessage(
            0,
            hook.messageTransmitter().localDomain(),
            hook.hyperlaneDomainToCircleDomain(destination),
            hook.messageTransmitter().nextAvailableNonce(),
            address(hook).addressToBytes32(),
            router,
            bytes32(0), // destinationCaller
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

    function testFork_verify() public virtual {
        vm.createSelectFork(vm.rpcUrl("base"), 32_739_842);
        TokenBridgeCctpV1 hook = TokenBridgeCctpV1(
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

        // https://iris-api.circle.com/v1/messages/6/0x4eeffc2aa410ede620d17ae18f513bf31941d301e8ada6676b54d3300dac116a
        bytes
            memory attestation = hex"4a713f6935bf2f0a9b6aa01a9a5c1c4e0da23f858193f20fde96e814e63345d85a65b6f1f53f0b22cde3c611d03a032eab7ac4c26232f3a7ff9185c69ee205ee1b614fac487343203b8c6e2c210440576fbe64e7fb70de5f4be87291187604656d19c4ebc4dc33558d36e6e799fc8adca45f8b704cf6eecf3adf7254ad88d2efd41c";
        bytes memory metadata = abi.encode(cctpMessage, attestation);

        vm.createSelectFork(vm.rpcUrl("mainnet"), 22_898_879);
        TokenBridgeCctpV1 ism = TokenBridgeCctpV1(router.bytes32ToAddress());
        _upgrade(ism);

        vm.prank(ism.owner());
        ism.addDomain(origin, 6);

        // Sender validation happens inside receiveMessage via callback to _authenticateCircleSender
        vm.expectRevert(TokenBridgeCctpBase.UnauthorizedCircleSender.selector);
        ism.verify(metadata, message);

        // CCTP message was sent by deployer on origin chain
        // enroll the deployer as the origin router
        address deployer = 0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba;
        vm.prank(ism.owner());
        ism.enrollRemoteRouter(origin, deployer.addressToBytes32());

        vm.expectCall(
            address(ism),
            abi.encode(TokenBridgeCctpV1.handleReceiveMessage.selector)
        );
        assert(ism.verify(metadata, message));
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
        vm.expectRevert(TokenBridgeCctpBase.MessageNotDispatched.selector);
        tbOrigin.postDispatch(bytes(""), message);
    }

    function test_hookType() public {
        assertEq(tbOrigin.hookType(), uint8(IPostDispatchHook.HookTypes.CCTP));
    }

    function test_supportsMetadata() public {
        assertEq(tbOrigin.supportsMetadata(bytes("")), true);
        assertEq(
            tbOrigin.supportsMetadata(
                StandardHookMetadata.format(0, 100_000, address(this))
            ),
            true
        );
    }

    function test_quoteDispatch() public {
        assertEq(tbOrigin.quoteDispatch(bytes(""), bytes("")), 0);
    }

    function test_postDispatch_refundsExcessValue(
        bytes32 recipient,
        bytes calldata body
    ) public virtual {
        address refundAddress = makeAddr("refundAddress");
        uint256 refundBalanceBefore = refundAddress.balance;

        // Create metadata with refund address using standard hook metadata format
        bytes memory metadata = abi.encodePacked(
            uint16(1), // variant
            uint256(0), // msgValue
            uint256(0), // gasLimit
            refundAddress // refundAddress
        );

        uint256 excessValue = 1 ether;

        mailboxOrigin.dispatch{value: excessValue}(
            destination,
            recipient,
            body,
            metadata,
            tbOrigin
        );

        // Verify refund was sent
        assertEq(refundAddress.balance, refundBalanceBefore + excessValue);
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

        bytes memory cctpMessage = _encodeCctpHookMessage(abi.encode(id));
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

        bytes memory cctpMessage = _encodeCctpHookMessage(
            badSender,
            address(tbDestination).addressToBytes32(),
            abi.encode(Message.id(message))
        );

        bytes memory attestation = bytes("");
        bytes memory metadata = abi.encode(cctpMessage, attestation);

        // Sender validation happens inside receiveMessage via callback to _authenticateCircleSender
        vm.expectRevert(TokenBridgeCctpBase.UnauthorizedCircleSender.selector);
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

        bytes memory cctpMessage = _encodeCctpHookMessage(
            abi.encode(badMessageId)
        );

        bytes memory attestation = bytes("");
        bytes memory metadata = abi.encode(cctpMessage, attestation);

        vm.expectRevert(TokenBridgeCctpBase.InvalidMessageId.selector);
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
        bytes memory cctpMessage = _encodeCctpHookMessage(
            address(tbOrigin).addressToBytes32(),
            badRecipient.addressToBytes32(),
            abi.encode(Message.id(message))
        );

        bytes memory attestation = bytes("");
        bytes memory metadata = abi.encode(cctpMessage, attestation);

        vm.expectRevert(TokenBridgeCctpBase.InvalidCircleRecipient.selector);
        tbDestination.verify(metadata, message);
    }

    // ============ handleReceiveMessage Tests (V1 only) ============

    function test_handleReceiveMessage(bytes calldata message) public virtual {
        bytes32 messageId = Message.id(message);
        // Call handleReceiveMessage from the message transmitter
        vm.prank(address(messageTransmitterDestination));
        bool result = TokenBridgeCctpV1(address(tbDestination))
            .handleReceiveMessage(
                cctpOrigin,
                address(tbOrigin).addressToBytes32(),
                abi.encode(messageId)
            );

        assertTrue(result);
        assertTrue(
            TokenBridgeCctpBase(address(tbDestination)).isVerified(messageId)
        );
    }

    function test_handleReceiveMessage_revertsWhen_unauthorizedSender(
        bytes32 messageId
    ) public virtual {
        // Try to call from an unauthorized address
        vm.prank(address(messageTransmitterDestination));
        vm.expectRevert(TokenBridgeCctpBase.UnauthorizedCircleSender.selector);
        TokenBridgeCctpV1(address(tbDestination)).handleReceiveMessage(
            cctpOrigin,
            evil.addressToBytes32(),
            abi.encode(messageId)
        );
    }

    function test_handleReceiveMessage_revertsWhen_unauthorizedCaller(
        bytes32 messageId
    ) public virtual {
        // Try to call from a non-message-transmitter address
        vm.prank(evil);
        vm.expectRevert(TokenBridgeCctpBase.NotMessageTransmitter.selector);
        TokenBridgeCctpV1(address(tbDestination)).handleReceiveMessage(
            cctpOrigin,
            address(tbOrigin).addressToBytes32(),
            abi.encode(messageId)
        );
    }

    function test_handleReceiveMessage_revertsWhen_unconfiguredDomain(
        uint32 badDomain,
        bytes32 messageId
    ) public virtual {
        // Assume the domain is not configured
        vm.assume(badDomain != cctpOrigin);
        vm.assume(badDomain != cctpDestination);

        vm.prank(address(messageTransmitterDestination));
        vm.expectRevert(
            TokenBridgeCctpBase.HyperlaneDomainNotConfigured.selector
        );
        TokenBridgeCctpV1(address(tbDestination)).handleReceiveMessage(
            badDomain,
            address(tbOrigin).addressToBytes32(),
            abi.encode(messageId)
        );
    }

    function test_handleReceiveMessage_revertsWhen_unenrolledRouter(
        bytes32 badRouter,
        bytes32 messageId
    ) public virtual {
        // Assume the router is different from the enrolled one
        vm.assume(badRouter != address(tbOrigin).addressToBytes32());

        vm.prank(address(messageTransmitterDestination));
        vm.expectRevert(TokenBridgeCctpBase.UnauthorizedCircleSender.selector);
        TokenBridgeCctpV1(address(tbDestination)).handleReceiveMessage(
            cctpOrigin,
            badRouter,
            abi.encode(messageId)
        );
    }

    function test_verify_returnsTrue_afterDirectDelivery(
        bytes calldata message
    ) public virtual {
        bytes32 messageId = Message.id(message);

        // First, deliver the message directly via handleReceiveMessage
        vm.prank(address(messageTransmitterDestination));
        assertTrue(
            TokenBridgeCctpV1(address(tbDestination)).handleReceiveMessage(
                cctpOrigin,
                address(tbOrigin).addressToBytes32(),
                abi.encode(messageId)
            )
        );

        // Verify the message is marked as verified
        assertTrue(
            TokenBridgeCctpBase(address(tbDestination)).isVerified(messageId)
        );

        // Now call verify with empty metadata - should return true without attestation
        bytes memory metadata = abi.encode(bytes(""), bytes(""));
        assertTrue(tbDestination.verify(metadata, message));
    }

    function test_verify_revertsWhen_tokenMessageAlreadyDelivered()
        public
        virtual
    {
        // Setup a token transfer
        (
            bytes memory message,
            uint64 cctpNonce,
            bytes32 recipient
        ) = _setupAndDispatch();

        // Create CCTP message for the token transfer
        bytes memory cctpMessage = _encodeCctpBurnMessage(
            cctpNonce,
            cctpOrigin,
            recipient,
            amount
        );

        bytes memory metadata = abi.encode(cctpMessage, bytes(""));
        tbDestination.verify(metadata, message);

        // The exact revert message depends on the mock implementation
        // In a real scenario, Circle's MessageTransmitter would revert with a nonce already used error
        vm.expectRevert();
        tbDestination.verify(metadata, message);
    }
}

contract TokenBridgeCctpV2Test is TokenBridgeCctpV1Test {
    using TypeCasts for address;

    uint256 constant maxFee = 1;
    uint32 constant minFinalityThreshold = 1000;

    address constant deployer = 0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba;

    function setUp() public override {
        super.setUp();

        version = CCTP_VERSION_2;

        tokenMessengerOrigin.setVersion(CCTP_VERSION_2);
        messageTransmitterOrigin.setVersion(CCTP_VERSION_2);

        tokenMessengerDestination.setVersion(CCTP_VERSION_2);
        messageTransmitterDestination.setVersion(CCTP_VERSION_2);

        TokenBridgeCctpV2 originImplementation = new TokenBridgeCctpV2(
            address(tokenOrigin),
            address(mailboxOrigin),
            messageTransmitterOrigin,
            tokenMessengerOrigin,
            maxFee,
            minFinalityThreshold
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
        tbOrigin = TokenBridgeCctpV2(address(proxyOrigin));

        TokenBridgeCctpV2 destinationImplementation = new TokenBridgeCctpV2(
            address(tokenDestination),
            address(mailboxDestination),
            messageTransmitterDestination,
            tokenMessengerDestination,
            maxFee,
            minFinalityThreshold
        );

        TransparentUpgradeableProxy proxyDestination = new TransparentUpgradeableProxy(
                address(destinationImplementation),
                proxyAdmin,
                initData
            );

        tbDestination = TokenBridgeCctpV2(address(proxyDestination));

        _setupTokenBridgesCctp(tbOrigin, tbDestination);
    }

    function _setNonce(bytes memory cctpMessage, bytes32 nonce) internal view {
        // length + NONCE_INDEX
        uint256 nonceOffset = 32 + 12;
        assembly {
            mstore(add(cctpMessage, nonceOffset), nonce)
        }
    }

    function _encodeCctpBurnMessage(
        uint64 nonce,
        uint32 sourceDomain,
        bytes32 recipient,
        uint256 amount,
        address sender
    ) internal view override returns (bytes memory cctpMessage) {
        uint256 fee = Math.mulDiv(
            amount,
            maxFee,
            10_000 - maxFee,
            Math.Rounding.Up
        );
        bytes memory burnMessage = BurnMessageV2._formatMessageForRelay(
            version,
            address(tokenOrigin).addressToBytes32(),
            recipient,
            amount + fee,
            sender.addressToBytes32(),
            maxFee,
            bytes("")
        );
        cctpMessage = CctpMessageV2._formatMessageForRelay(
            version,
            sourceDomain,
            cctpDestination,
            address(tokenMessengerOrigin).addressToBytes32(),
            address(tokenMessengerDestination).addressToBytes32(),
            bytes32(0),
            minFinalityThreshold,
            burnMessage
        );
        // pseudo random
        bytes32 nonceBytes = keccak256(
            abi.encode(nonce, sender, recipient, amount)
        );
        _setNonce(cctpMessage, nonceBytes);
    }

    function _encodeCctpHookMessage(
        bytes32 sender,
        bytes32 recipient,
        bytes memory message
    ) internal view override returns (bytes memory cctpMessage) {
        cctpMessage = CctpMessageV2._formatMessageForRelay(
            version,
            cctpOrigin,
            cctpDestination,
            sender,
            recipient,
            bytes32(0),
            minFinalityThreshold,
            message
        );
        // pseudo random nonce
        bytes32 nonce = keccak256(abi.encode(sender, recipient, message));
        _setNonce(cctpMessage, nonce);
    }

    address constant usdc = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    function _deploy() internal returns (TokenBridgeCctpV2) {
        ITokenMessengerV2 tokenMessenger = ITokenMessengerV2(
            address(0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d)
        );

        IMessageTransmitterV2 messageTransmitter = IMessageTransmitterV2(
            address(0x81D40F21F12A8F0E3252Bccb954D722d4c464B64)
        );

        TokenBridgeCctpV2 implementation = new TokenBridgeCctpV2(
            usdc,
            0xeA87ae93Fa0019a82A727bfd3eBd1cFCa8f64f1D,
            messageTransmitter,
            tokenMessenger,
            maxFee,
            minFinalityThreshold
        );

        // deploy proxy code to deployer address, which is configured as recipient on cctp messages
        deployCodeTo(
            "dependencies/@openzeppelin-contracts-4.9.3/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy",
            abi.encode(
                address(implementation),
                proxyAdmin,
                abi.encodeWithSignature(
                    "initialize(address,address,string[])",
                    address(0),
                    address(this),
                    _getUrls()
                )
            ),
            address(deployer)
        );

        return TokenBridgeCctpV2(address(deployer));
    }

    function testFork_verify() public override {
        vm.createSelectFork(vm.rpcUrl("base"), 32_739_842);

        uint32 circleDestination = 6;
        uint32 origin = 10;
        TokenBridgeCctpV2 ism = _deploy();
        uint32 circleOrigin = 2;
        ism.addDomain(origin, circleOrigin);
        ism.enrollRemoteRouter(origin, deployer.addressToBytes32());

        // https://optimistic.etherscan.io/tx/0xf53a6a2cb5a334706912b96088171251df1400156a0a0a68a79fe70961634f65
        bytes
            memory message = hex"030010EF000000000A000000000000000000000000A7ECCDB9BE08178F896C26B7BBD8C3D4E844D9BA00002105000000000000000000000000A7ECCDB9BE08178F896C26B7BBD8C3D4E844D9BADEADBEEF";

        // https://optimistic.etherscan.io/tx/0xc50f4acd4e442529b9814b252e8b568b72e10720b18603232c73124ac1e9ae1f
        bytes
            memory originalCctpMessage = hex"0000000100000002000000060000000000000000000000000000000000000000000000000000000000000000000000000000000000000000A7ECCDB9BE08178F896C26B7BBD8C3D4E844D9BA000000000000000000000000A7ECCDB9BE08178F896C26B7BBD8C3D4E844D9BA000000000000000000000000A7ECCDB9BE08178F896C26B7BBD8C3D4E844D9BA000003E800000000B410A464EC38D27F7C9394F9BF9B1EF1A5921F5E82FE77CF67A10DB6FE8425FD";

        // https://iris-api.circle.com/v2/messages/2?transactionHash=0xc50f4acd4e442529b9814b252e8b568b72e10720b18603232c73124ac1e9ae1f
        bytes
            memory cctpMessage = hex"000000010000000200000006a94cc8b2c5a35f696379d89ca4cd0a0d7058c6c2e949ac08e8dfc607cc0590f9000000000000000000000000a7eccdb9be08178f896c26b7bbd8c3d4e844d9ba000000000000000000000000a7eccdb9be08178f896c26b7bbd8c3d4e844d9ba000000000000000000000000a7eccdb9be08178f896c26b7bbd8c3d4e844d9ba000003e8000003e8b410a464ec38d27f7c9394f9bf9b1ef1a5921f5e82fe77cf67a10db6fe8425fd";
        bytes
            memory attestation = hex"fdaca657526b164d6b09678297565d40e1e68cad3bfb0786470b0e8bce013ee340a985970d69629af69599f3deff5cc975b3df46d2efeadfebd867d049e5e5641cba6f5e720dc86c90d8d51747619fbe2b24246e36fa0603792cb86ad88bdc06136663d6211a8d5d134cf94cf8197892a460b24a5e21715642d338530b472a325d1c";
        bytes memory metadata = abi.encode(cctpMessage, attestation);

        vm.expectCall(
            address(ism),
            abi.encode(
                TokenBridgeCctpV2.handleReceiveUnfinalizedMessage.selector
            )
        );
        assert(ism.verify(metadata, message));
    }

    function testFork_transferRemote(bytes32 recipient, uint32 amount) public {
        // recipient cannot be bytes32(0) in CCTP
        vm.assume(recipient != bytes32(0));

        // depositForBurn will revert if amount is less than maxFee
        vm.assume(amount > maxFee);
        vm.createSelectFork(vm.rpcUrl("base"), 32_739_842);

        bytes32 ism = 0x0000000000000000000000000000000000000000000000000000000000000001;

        TokenBridgeCctpV2 router = _deploy();

        uint32 destination = 1; // ethereum
        uint32 circleDestination = 0;
        router.addDomain(destination, circleDestination);
        router.enrollRemoteRouter(destination, ism);

        Quote[] memory quotes = router.quoteTransferRemote(
            destination,
            recipient,
            amount
        );

        assertEq(quotes[1].token, usdc);
        uint256 usdcQuote = quotes[1].amount;

        assertEq(quotes[2].token, usdc);
        uint256 fastFee = quotes[2].amount;

        deal(usdc, address(this), usdcQuote + fastFee);
        IERC20(usdc).approve(address(router), usdcQuote + fastFee);

        vm.expectEmit(true, true, true, true, address(router.tokenMessenger()));
        emit ITokenMessengerV2.DepositForBurn(
            usdc,
            usdcQuote + fastFee,
            address(router),
            recipient,
            circleDestination,
            bytes32(
                0x00000000000000000000000028b5a0e9c621a5badaa536219b3a228c8168cf5d
            ), // tokenMessengerDestination
            ism, // destinationCaller
            fastFee,
            minFinalityThreshold,
            bytes("")
        );

        router.transferRemote{value: quotes[0].amount}(
            destination,
            recipient,
            amount
        );
    }

    event MintAndWithdraw(
        address indexed mintRecipient,
        uint256 amount,
        address indexed mintToken,
        uint256 feeCollected
    );

    function testFork_verify_tokenMessage() public {
        vm.createSelectFork(vm.rpcUrl("base"), 32_739_842);

        TokenBridgeCctpV2 ism = _deploy();

        bytes32 hook = deployer.addressToBytes32();

        uint32 origin = 10; // optimism
        uint32 circleOrigin = 2;
        ism.addDomain(origin, circleOrigin);
        ism.enrollRemoteRouter(origin, hook);

        // https://optimistic.etherscan.io/tx/0x4a8c5aef605bd1a79d7e4ab7b1852d246a05859a168db2b4791563877f2f3325
        uint256 amount = 2;
        uint256 fee = 1;
        bytes
            memory cctpMessage = hex"0000000100000002000000069abb52aa4e37d2ee3e521f9bc92e97581a68dadcd826fd2abaa5150de95db90e00000000000000000000000028b5a0e9c621a5badaa536219b3a228c8168cf5d00000000000000000000000028b5a0e9c621a5badaa536219b3a228c8168cf5d000000000000000000000000a7eccdb9be08178f896c26b7bbd8c3d4e844d9ba000003e8000003e8000000010000000000000000000000000b2c639c533813f4aa9d7837caf62653d097ff85000000000000000000000000a7eccdb9be08178f896c26b7bbd8c3d4e844d9ba0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000a7eccdb9be08178f896c26b7bbd8c3d4e844d9ba000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000001f825d8";

        // https://iris-api.circle.com/v2/messages/2?transactionHash=0x4a8c5aef605bd1a79d7e4ab7b1852d246a05859a168db2b4791563877f2f3325
        bytes
            memory attestation = hex"f75d61f667685827a63a857fcfae06fd9c42860c9a94175a2041a98941c874303aa44a973bf28b447ecc39e25d81a869584e9379d41f669dc526bf3b6810a0161c278bcd556ac5dd462095094af97a8773b33c00788a362c424d5569bdb4c2fb853ab4aefab3839bc8128e280f16fc09c6cfb11361061e527f5804fa6c6b130dc91b";

        bytes memory metadata = abi.encode(cctpMessage, attestation);

        bytes memory message = abi.encodePacked(
            uint8(3),
            uint32(0),
            origin,
            hook,
            ism.localDomain(),
            address(ism).addressToBytes32(),
            abi.encode(hook, amount)
        );

        vm.expectEmit(true, true, true, true, address(ism.tokenMessenger()));
        emit MintAndWithdraw(deployer, amount - fee, usdc, fee);
        ism.verify(metadata, message);
    }

    function testFork_postDispatch(
        bytes32 recipient,
        bytes calldata body
    ) public override {
        vm.createSelectFork(vm.rpcUrl("base"), 32_739_842);

        bytes32 ism = 0x0000000000000000000000000000000000000000000000000000000000000001;

        TokenBridgeCctpV2 hook = _deploy();

        IMailbox mailbox = hook.mailbox();
        uint32 origin = mailbox.localDomain();
        uint32 destination = 1; // ethereum
        hook.addDomain(destination, 0);
        hook.enrollRemoteRouter(destination, ism);

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

        bytes memory cctpMessage = CctpMessageV2._formatMessageForRelay(
            CCTP_VERSION_2,
            hook.messageTransmitter().localDomain(),
            hook.hyperlaneDomainToCircleDomain(destination),
            address(hook).addressToBytes32(),
            ism,
            ism, // destinationCaller
            minFinalityThreshold,
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

    function test_transferRemoteCctp() public override {
        Quote[] memory quote = tbOrigin.quoteTransferRemote(
            destination,
            user.addressToBytes32(),
            amount
        );

        uint256 tokenQuote = quote[1].amount;
        uint256 fastFee = quote[2].amount;
        vm.startPrank(user);
        tokenOrigin.approve(address(tbOrigin), tokenQuote + fastFee);

        vm.expectCall(
            address(tokenMessengerOrigin),
            abi.encodeCall(
                ITokenMessengerV2.depositForBurn,
                (
                    tokenQuote + fastFee,
                    cctpDestination,
                    user.addressToBytes32(),
                    address(tokenOrigin),
                    address(tbDestination).addressToBytes32(),
                    fastFee,
                    minFinalityThreshold
                )
            )
        );
        tbOrigin.transferRemote{value: quote[0].amount}(
            destination,
            user.addressToBytes32(),
            amount
        );
    }

    function test_transferRemoteCctp_withFeeRecipient() public override {
        LinearFee feeContract = new LinearFee(
            address(tokenOrigin),
            1e6,
            amount / 2,
            address(this)
        );
        tbOrigin.setFeeRecipient(address(feeContract));
        uint256 feeRecipientFee = feeContract
        .quoteTransferRemote(destination, user.addressToBytes32(), amount)[0]
            .amount;

        Quote[] memory quotes = tbOrigin.quoteTransferRemote(
            destination,
            user.addressToBytes32(),
            amount
        );

        uint256 tokenQuote = quotes[1].amount;
        uint256 fastFee = quotes[2].amount;

        vm.startPrank(user);
        tokenOrigin.approve(address(tbOrigin), tokenQuote + fastFee);

        uint64 cctpNonce = tokenMessengerOrigin.nextNonce();

        vm.expectCall(
            address(tokenMessengerOrigin),
            abi.encodeCall(
                ITokenMessengerV2.depositForBurn,
                (
                    tokenQuote + fastFee - feeRecipientFee,
                    cctpDestination,
                    user.addressToBytes32(),
                    address(tokenOrigin),
                    address(tbDestination).addressToBytes32(),
                    fastFee,
                    minFinalityThreshold
                )
            )
        );
        tbOrigin.transferRemote{value: quotes[0].amount}(
            destination,
            user.addressToBytes32(),
            amount
        );
    }

    function test_postDispatch(
        bytes32 recipient,
        bytes calldata body
    ) public override {
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

        bytes32 ism = address(tbDestination).addressToBytes32();
        vm.expectCall(
            address(messageTransmitterOrigin),
            abi.encodeCall(
                IRelayerV2.sendMessage,
                (
                    cctpDestination,
                    ism,
                    ism, // destinationCaller
                    minFinalityThreshold,
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

    function test_revertsWhen_versionIsNotSupported() public override {
        tokenMessengerOrigin.setVersion(CCTP_VERSION_1);

        vm.expectRevert(TokenBridgeCctpBase.InvalidCCTPVersion.selector);
        TokenBridgeCctpV2 v2 = new TokenBridgeCctpV2(
            address(tokenOrigin),
            address(mailboxOrigin),
            messageTransmitterOrigin,
            tokenMessengerOrigin,
            maxFee,
            minFinalityThreshold
        );

        messageTransmitterOrigin.setVersion(CCTP_VERSION_1);
        vm.expectRevert(TokenBridgeCctpBase.InvalidCCTPVersion.selector);
        v2 = new TokenBridgeCctpV2(
            address(tokenOrigin),
            address(mailboxOrigin),
            messageTransmitterOrigin,
            tokenMessengerOrigin,
            maxFee,
            minFinalityThreshold
        );
    }

    // function test_verify_revertsWhen_invalidNonce() public override {
    //     vm.skip(true);
    //     // cannot assert nonce in v2
    // }

    function testFork_verify_upgrade() public override {
        vm.skip(true);
    }

    function test_quoteTransferRemote_getCorrectQuote() public override {
        Quote[] memory quotes = tbOrigin.quoteTransferRemote(
            destination,
            user.addressToBytes32(),
            amount
        );

        assertEq(quotes.length, 3);
        assertEq(quotes[0].token, address(0));
        assertEq(
            quotes[0].amount,
            igpOrigin.quoteGasPayment(destination, gasLimit)
        );
        assertEq(quotes[1].token, address(tokenOrigin));
        assertEq(quotes[1].amount, amount);
        // rounded up using Math.mulDiv with Rounding.Up
        uint256 fastFee = Math.mulDiv(
            amount,
            maxFee,
            10_000 - maxFee,
            Math.Rounding.Up
        );
        assertEq(quotes[2].token, address(tokenOrigin));
        assertEq(quotes[2].amount, fastFee);
    }

    // ============ Override V1 handleReceiveMessage tests (V2 doesn't have this function) ============

    // function test_handleReceiveMessage(bytes32) public pure override {
    //     // V2 doesn't have handleReceiveMessage, skip this test
    // }

    function test_handleReceiveMessage_revertsWhen_unauthorizedSender(
        bytes32
    ) public pure override {
        // V2 doesn't have handleReceiveMessage, skip this test
    }

    function test_handleReceiveMessage_revertsWhen_unauthorizedCaller(
        bytes32
    ) public pure override {
        // V2 doesn't have handleReceiveMessage, skip this test
    }

    function test_handleReceiveMessage_revertsWhen_unconfiguredDomain(
        uint32,
        bytes32
    ) public pure override {
        // V2 doesn't have handleReceiveMessage, skip this test
    }

    function test_handleReceiveMessage_revertsWhen_unenrolledRouter(
        bytes32,
        bytes32
    ) public pure override {
        // V2 doesn't have handleReceiveMessage, skip this test
    }

    // ============ handleReceiveFinalizedMessage Tests (V2 only) ============

    function test_handleReceiveMessage(bytes calldata message) public override {
        uint32 finalityThreshold = 2000;
        bytes32 messageId = Message.id(message);
        // Call handleReceiveFinalizedMessage from the message transmitter
        vm.prank(address(messageTransmitterDestination));
        bool result = TokenBridgeCctpV2(address(tbDestination))
            .handleReceiveFinalizedMessage(
                cctpOrigin,
                address(tbOrigin).addressToBytes32(),
                finalityThreshold,
                abi.encode(messageId)
            );

        assertTrue(result);
        assertTrue(
            TokenBridgeCctpBase(address(tbDestination)).isVerified(messageId)
        );
    }

    function test_handleReceiveFinalizedMessage_revertsWhen_unauthorizedSender(
        bytes32 messageId,
        uint32 finalityThreshold
    ) public {
        vm.prank(address(messageTransmitterDestination));
        vm.expectRevert(TokenBridgeCctpBase.UnauthorizedCircleSender.selector);
        TokenBridgeCctpV2(address(tbDestination)).handleReceiveFinalizedMessage(
            cctpOrigin,
            evil.addressToBytes32(),
            finalityThreshold,
            abi.encode(messageId)
        );
    }

    function test_handleReceiveFinalizedMessage_revertsWhen_unauthorizedCaller(
        bytes32 messageId,
        uint32 finalityThreshold
    ) public {
        vm.prank(evil);
        vm.expectRevert(TokenBridgeCctpBase.NotMessageTransmitter.selector);
        TokenBridgeCctpV2(address(tbDestination)).handleReceiveFinalizedMessage(
            cctpOrigin,
            address(tbOrigin).addressToBytes32(),
            finalityThreshold,
            abi.encode(messageId)
        );
    }

    function test_handleReceiveFinalizedMessage_revertsWhen_unconfiguredDomain(
        uint32 badDomain,
        bytes32 messageId,
        uint32 finalityThreshold
    ) public {
        vm.assume(badDomain != cctpOrigin);
        vm.assume(badDomain != cctpDestination);

        vm.prank(address(messageTransmitterDestination));
        vm.expectRevert(
            TokenBridgeCctpBase.HyperlaneDomainNotConfigured.selector
        );
        TokenBridgeCctpV2(address(tbDestination)).handleReceiveFinalizedMessage(
            badDomain,
            address(tbOrigin).addressToBytes32(),
            finalityThreshold,
            abi.encode(messageId)
        );
    }

    function test_handleReceiveFinalizedMessage_revertsWhen_unenrolledRouter(
        bytes32 badRouter,
        bytes32 messageId,
        uint32 finalityThreshold
    ) public {
        vm.assume(badRouter != address(tbOrigin).addressToBytes32());

        vm.prank(address(messageTransmitterDestination));
        vm.expectRevert(TokenBridgeCctpBase.UnauthorizedCircleSender.selector);
        TokenBridgeCctpV2(address(tbDestination)).handleReceiveFinalizedMessage(
            cctpOrigin,
            badRouter,
            finalityThreshold,
            abi.encode(messageId)
        );
    }

    // ============ handleReceiveUnfinalizedMessage Tests (V2 only) ============

    function test_handleReceiveUnfinalizedMessage(
        bytes calldata message,
        uint32 finalityThreshold
    ) public {
        bytes32 messageId = Message.id(message);
        // Call handleReceiveUnfinalizedMessage from the message transmitter
        vm.prank(address(messageTransmitterDestination));
        bool result = TokenBridgeCctpV2(address(tbDestination))
            .handleReceiveUnfinalizedMessage(
                cctpOrigin,
                address(tbOrigin).addressToBytes32(),
                finalityThreshold,
                abi.encode(messageId)
            );

        assertTrue(result);
        assertTrue(
            TokenBridgeCctpBase(address(tbDestination)).isVerified(messageId)
        );
    }

    function test_handleReceiveUnfinalizedMessage_revertsWhen_unauthorizedSender(
        bytes32 messageId,
        uint32 finalityThreshold
    ) public {
        vm.prank(address(messageTransmitterDestination));
        vm.expectRevert(TokenBridgeCctpBase.UnauthorizedCircleSender.selector);
        TokenBridgeCctpV2(address(tbDestination))
            .handleReceiveUnfinalizedMessage(
                cctpOrigin,
                evil.addressToBytes32(),
                finalityThreshold,
                abi.encode(messageId)
            );
    }

    function test_handleReceiveUnfinalizedMessage_revertsWhen_unauthorizedCaller(
        bytes32 messageId,
        uint32 finalityThreshold
    ) public {
        vm.prank(evil);
        vm.expectRevert(TokenBridgeCctpBase.NotMessageTransmitter.selector);
        TokenBridgeCctpV2(address(tbDestination))
            .handleReceiveUnfinalizedMessage(
                cctpOrigin,
                address(tbOrigin).addressToBytes32(),
                finalityThreshold,
                abi.encode(messageId)
            );
    }

    function test_handleReceiveUnfinalizedMessage_revertsWhen_unconfiguredDomain(
        uint32 badDomain,
        bytes32 messageId,
        uint32 finalityThreshold
    ) public {
        vm.assume(badDomain != cctpOrigin);
        vm.assume(badDomain != cctpDestination);

        vm.prank(address(messageTransmitterDestination));
        vm.expectRevert(
            TokenBridgeCctpBase.HyperlaneDomainNotConfigured.selector
        );
        TokenBridgeCctpV2(address(tbDestination))
            .handleReceiveUnfinalizedMessage(
                badDomain,
                address(tbOrigin).addressToBytes32(),
                finalityThreshold,
                abi.encode(messageId)
            );
    }

    function test_handleReceiveUnfinalizedMessage_revertsWhen_unenrolledRouter(
        bytes32 badRouter,
        bytes32 messageId,
        uint32 finalityThreshold
    ) public {
        vm.assume(badRouter != address(tbOrigin).addressToBytes32());

        vm.prank(address(messageTransmitterDestination));
        vm.expectRevert(TokenBridgeCctpBase.UnauthorizedCircleSender.selector);
        TokenBridgeCctpV2(address(tbDestination))
            .handleReceiveUnfinalizedMessage(
                cctpOrigin,
                badRouter,
                finalityThreshold,
                abi.encode(messageId)
            );
    }

    function test_verify_returnsTrue_afterDirectDelivery(
        bytes calldata message
    ) public override {
        bytes32 messageId = Message.id(message);
        uint32 finalityThreshold = 2000;

        // First, deliver the message directly via handleReceiveFinalizedMessage
        vm.prank(address(messageTransmitterDestination));
        assertTrue(
            TokenBridgeCctpV2(address(tbDestination))
                .handleReceiveFinalizedMessage(
                    cctpOrigin,
                    address(tbOrigin).addressToBytes32(),
                    finalityThreshold,
                    abi.encode(messageId)
                )
        );

        // Verify the message is marked as verified
        assertTrue(
            TokenBridgeCctpBase(address(tbDestination)).isVerified(messageId)
        );

        // Now call verify with empty metadata - should return true without attestation
        bytes memory metadata = abi.encode(bytes(""), bytes(""));
        assertTrue(tbDestination.verify(metadata, message));
    }

    function test_verify_returnsTrue_afterUnfinalizedDirectDelivery(
        bytes calldata message
    ) public {
        bytes32 messageId = Message.id(message);
        uint32 finalityThreshold = 1500;

        // First, deliver the message directly via handleReceiveUnfinalizedMessage
        vm.prank(address(messageTransmitterDestination));
        assertTrue(
            TokenBridgeCctpV2(address(tbDestination))
                .handleReceiveUnfinalizedMessage(
                    cctpOrigin,
                    address(tbOrigin).addressToBytes32(),
                    finalityThreshold,
                    abi.encode(messageId)
                )
        );

        // Verify the message is marked as verified
        assertTrue(
            TokenBridgeCctpBase(address(tbDestination)).isVerified(messageId)
        );

        // Now call verify with empty metadata - should return true without attestation
        bytes memory metadata = abi.encode(bytes(""), bytes(""));
        assertTrue(tbDestination.verify(metadata, message));
    }

    function test_verify_revertsWhen_tokenMessageAlreadyDelivered()
        public
        override
    {
        // Setup a token transfer
        (
            bytes memory message,
            uint64 cctpNonce,
            bytes32 recipient
        ) = _setupAndDispatch();

        // Create CCTP V2 message for the token transfer
        bytes memory cctpMessage = _encodeCctpBurnMessage(
            cctpNonce,
            cctpOrigin,
            recipient,
            amount
        );

        bytes memory metadata = abi.encode(cctpMessage, bytes(""));
        tbDestination.verify(metadata, message);

        // The exact revert message depends on the mock implementation
        // In a real scenario, Circle's MessageTransmitter would revert with a nonce already used error
        vm.expectRevert();
        tbDestination.verify(metadata, message);
    }
}
