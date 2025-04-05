// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Script, console} from "forge-std/Script.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";
import {Message} from "../contracts/libs/Message.sol";
import {TokenMessage} from "../contracts/token/libs/TokenMessage.sol";
import {OPValueTransferBridgeNative} from "../contracts/token/OPValueTransferBridgeNative.sol";
import {OPL2ToL1CcipReadIsm} from "../contracts/isms/hook/OPL2ToL1CcipReadIsm.sol";
import {OPL2ToL1CcipReadHook} from "../contracts/hooks/OPL2ToL1CcipReadHook.sol";
import {IOptimismPortal} from "../contracts/interfaces/optimism/IOptimismPortal.sol";
import {Quotes} from "../contracts/interfaces/IValueTransferBridge.sol";
import {SecureMerkleTrie} from "./SecureMerkleTrie.sol";
import {OPL2ToL1Hook} from "../contracts/hooks/OPL2ToL1Hook.sol";
import {OPL2ToL1Ism} from "../contracts/isms/hook/OPL2ToL1Ism.sol";
import {ICrossDomainMessenger} from "../contracts/interfaces/optimism/ICrossDomainMessenger.sol";

contract ValueTransferBridgeScript is Script {
    using TypeCasts for address;
    // using Message for bytes;
    using TokenMessage for bytes;

    uint256 L2_DOMAIN = vm.envUint("L2_DOMAIN");
    uint256 L1_DOMAIN = vm.envUint("L1_DOMAIN");
    // --------------------- Origin ---------------------
    address mailboxOrigin = vm.envAddress("L2_MAILBOX");
    address l2Bridge = vm.envAddress("L2_BRIDGE");

    uint32 origin = uint32(L2_DOMAIN);
    uint32 destination = uint32(L1_DOMAIN);

    // ------------------- Destination -------------------
    address mailboxDestination = vm.envAddress("L1_MAILBOX");
    address opPortal = vm.envAddress("L1_PORTAL");

    string[] urls = vm.envString("CCIP_READ_URLS", ",");

    function setHook(address payable vtb, address hook) public {
        vm.startBroadcast();
        OPValueTransferBridgeNative(vtb).setHook(hook);
        vm.stopBroadcast();
    }

    function setIsm(address payable vtb, address ism) public {
        vm.startBroadcast();
        OPValueTransferBridgeNative(vtb).setInterchainSecurityModule(ism);
        vm.stopBroadcast();
    }

    function setUrls(address _proveIsm) public {
        vm.startBroadcast();
        OPL2ToL1CcipReadIsm(_proveIsm).setUrls(urls);
        vm.stopBroadcast();
    }

    function deployValueTransferBridge(
        address _l2Bridge,
        address _mailbox
    ) public returns (address) {
        vm.startBroadcast();
        OPValueTransferBridgeNative vtb = new OPValueTransferBridgeNative(
            destination,
            _l2Bridge,
            _mailbox
        );
        console.log("ValueTransferBridgeNative @", address(vtb));
        vm.stopBroadcast();

        return address(vtb);
    }

    function deployHook(address proveWithdrawalIsm) public returns (address) {
        vm.startBroadcast();
        OPL2ToL1CcipReadHook hook = new OPL2ToL1CcipReadHook(
            mailboxOrigin,
            proveWithdrawalIsm,
            address(0)
        );
        vm.stopBroadcast();

        return address(hook);
    }

    function enrollRouter(
        address payable vtb,
        uint32 domain,
        address router
    ) public {
        vm.startBroadcast();
        OPValueTransferBridgeNative(vtb).enrollRemoteRouter(
            domain,
            router.addressToBytes32()
        );
        vm.stopBroadcast();
    }

    function deployIsm() public returns (address) {
        vm.startBroadcast();
        OPL2ToL1CcipReadIsm ism = new OPL2ToL1CcipReadIsm(
            urls,
            opPortal,
            mailboxDestination
        );
        ism.setUrls(urls);
        console.log("OPL2ToL1CcipReadIsm @", address(ism));

        vm.stopBroadcast();
        return address(ism);
    }

    function deployDestination()
        public
        returns (OPValueTransferBridgeNative vtb)
    {
        vm.startBroadcast();
        vtb = new OPValueTransferBridgeNative(
            destination,
            address(0),
            mailboxDestination
        );
        console.log("ValueTransferBridgeNative @", address(vtb));
        vm.stopBroadcast();
    }

    function transferRemote(
        address payable _vtb,
        uint32 _destination,
        address _recipient,
        uint256 amount
    ) public returns (bytes32 messageId) {
        vm.startBroadcast();
        OPValueTransferBridgeNative vtb = OPValueTransferBridgeNative(_vtb);
        bytes32 recipient = _recipient.addressToBytes32();
        Quotes[] memory quotes = vtb.quoteTransferRemote(
            destination,
            recipient,
            amount
        );

        messageId = vtb.transferRemote{value: amount + quotes[0].amount}(
            _destination,
            recipient,
            amount
        );

        console.log("messageId");
        console.logBytes32(messageId);
        vm.stopBroadcast();
    }

    function run() public {
        address recipient = msg.sender;
        uint256 amount = 0.000001337 ether;

        vm.createSelectFork("l1");
        (address remoteVtb, address ism) = deployAllDestination();

        vm.createSelectFork("l2");
        (address payable vtb, address hook) = deployAllOrigin(remoteVtb, ism);

        vm.createSelectFork("l1");
        enrollRouter(vtb, uint32(L2_DOMAIN), remoteVtb);

        console.log("# ============ L2 ============");
        console.log("# vtb  @ ", vtb);
        console.log("# hook @", hook);
        console.log("# ============ L1 ============");
        console.log("# vtb  @", remoteVtb);
        console.log("# ism  @", ism);
        // bytes32 messageId = transferRemote(
        //     payable(vtb),
        //     destination,
        //     recipient,
        //     amount
        // );
    }

    function deployAllOrigin(
        address remoteRouter,
        address proveWithdrawalIsm
    ) public returns (address payable vtb, address hook) {
        vtb = payable(deployValueTransferBridge(l2Bridge, mailboxOrigin));
        enrollRouter(vtb, destination, remoteRouter);
        hook = deployHook(proveWithdrawalIsm);

        vm.startBroadcast();
        OPValueTransferBridgeNative(vtb).setHook(hook);
        vm.stopBroadcast();

        console.log("vtb @ ", vtb);
        console.log("hook @ ", hook);
    }

    // function OPL2ToL1HookExample() public {
    //     address recipient = vm.addr(7);
    //     OPL2ToL1Ism secureMessageIsm = OPL2ToL1Ism(vm.addr(10));
    //     OPL2ToL1CcipReadIsm ccipReadIsm = OPL2ToL1CcipReadIsm(vm.addr(9));
    //     ICrossDomainMessenger messenger = ICrossDomainMessenger(vm.addr(11));

    //     OPL2ToL1CcipReadHook ccipReadHook = new OPL2ToL1CcipReadHook(
    //         mailboxOrigin,
    //         ccipReadIsm,
    //         address(0)
    //     );
    //     // We set the ccip read hook as child hook, this way the message
    //     // id is sent first through the rollup bridge to the secureMessageIsm
    //     // then the prove withdrawal message is sent to the ccipReadIsm
    //     OPL2ToL1Hook secureMessageHook = new OPL2ToL1Hook(
    //         mailboxOrigin,
    //         destination,
    //         secureMessageIsm,
    //         ccipReadHook
    //     );

    //     OPValueTransferBridgeNative vtb = new OPValueTransferBridgeNative(
    //         origin,
    //         l2Bridge,
    //         mailboxOrigin
    //     );
    //     vtb.setHook(secureMessageHook);

    //     vtb.transferRemote(destination, recipient, 0.001 ether);
    // }

    function deployAllDestination()
        public
        returns (address payable vtb, address ism)
    {
        vtb = payable(
            deployValueTransferBridge(address(0), mailboxDestination)
        );
        ism = deployIsm();

        vm.startBroadcast();
        OPValueTransferBridgeNative(vtb).setInterchainSecurityModule(ism);
        vm.stopBroadcast();

        console.log("vtb @", vtb);
        console.log("ccipReadIsm @", ism);
    }

    function process(bytes calldata metadata) public {
        // (
        //     IOptimismPortal.WithdrawalTransaction memory _tx,
        //     uint256 _disputeGameIndex,
        //     IOptimismPortal.OutputRootProof memory _outputRootProof,
        //     bytes[] memory _withdrawalProof
        // ) = abi.decode(
        //         metadata,
        //         (
        //             IOptimismPortal.WithdrawalTransaction,
        //             uint256,
        //             IOptimismPortal.OutputRootProof,
        //             bytes[]
        //         )
        //     );

        // bytes memory messageId = _getL2Message(_tx.data);

        // console.log("messageId");
        // console.logBytes32(abi.decode(messageId, (bytes32)));

        // console.log("withdrawal tx encoded");
        // console.logBytes(abi.encode(_tx));

        console.log("x:");
        console.logBytes(abi.decode(metadata, (bytes)));
    }

    function getRecipient(bytes calldata message) public {
        console.log("Recipient");
        // console.log(message.recipient() == address(this).addressToBytes32());
    }

    function validate() public {
        bytes memory key = vm.parseBytes(
            "0x8814ae3f1158128733ad1978b9ce6bfe4c9fedf7edcc630d5701a67c765c7d98"
        );
        bytes[] memory proof = new bytes[](4);

        proof[0] = vm.parseBytes(
            "0xf90211a077d8a4b25135114781829a4c8fb751245f5cf5d07c10c27658ff1856a8f7d210a0fdafe65f27e2a0eeb60733c87f0c41bc6a5515fe2b51156ac6627547510e377aa0b891016564f1db8fae99184f8c903f81759bfa7248a652ef1e1c889be03f5ab5a0cdf3f98ee864db2fa0f9f5e608061b32ca522a1b9d335584f2b25dfc7d2d66fea0d74ad29e033112d0f29974514f7ebad38bdadfc497d92bc2229b1c2a2fd05f43a01a12563ffb6b991e6865a005eff7f757718eedc00e9aaba0c610c629d3b3c122a0ddbf96e9f05506e04a2057bb8bef96aeb91e8540c5b61c52bb2447884e787a48a006181edc4e534100404206545d18dc9ec9f811ad60555186a398c1186f4f78eba0bf18115a0603bbaa2b998544614dbb0049887ab7747bb9f4f7fdfff8e934a99da0060d33429607c901b4aae7371853ae54c9f75b754aeb8d7442e65a96139fc604a02adb27c564c178ed89f49a84ae924cf5b09cdf6ffe96eb392c49f1fddd24aed4a026da3d771048efcd2885359fad83febac1eca9b4dc1ef354417698c505dc0b4da027a4db093efa6ca47a0aa274d83ed9f4fa9f77c9315d806faf8cc5c3a8c96eb2a0f5fe386a7ec0c1f4175b14ad4014e54453b344935461f38f583b6d33b10e8c20a03a7a97765985296e6502f736c3232989a9e64395069aac719d75b7a072af7efca0782118fc9f94fcd1cfeeb03145ba8b3e8dba7a3f315c811ee82e4d8360e048d580"
        );
        proof[1] = vm.parseBytes(
            "0xf90211a0d1aba495a965730a0115e2bff8106c89c4d597c5a6715ad108a7eef706718bffa04f59e1dab3f7cf8928288ba06c1e96e7c759bbf7e736cea2ec13b4528351586ca0f7f5007d1bb570b5910327950726ba4dc75f4335aef010676f2f0b140179d78ba052f206917f389ef0fedfbac25d60d8cdf73376b9d7b4b4ba3d0b8e1a8402b7aca0e075bdb828ddf1fe0ede26fe6baf7904b0e576aa936dac6fd70934f21064c557a06d148b40261bfa6b40065f0cb802f93904ee6eb73e0ffbc6d3e1ea58965c6f8da09662a42b5b86010537c7754f041c7544253c45c3fa3b6c1932620eae60ac3b49a0823c7bdb3ef79e1c33861414e343b1a3e3cfc28087b4d2627b8d983b5b3273dca0fff216ba46f7a08bc95cbaaf08a4e949eb26f5735552b76f0702e9923676a7aca0d2444defaa0b5592ca4c03219ed3d74d42ac327b08af3ec797debd372747d348a0a0f6cc28aaf1975b327f207195114920f826096b4a0a7ad828012f9f68da90c1a010818586e43879a41c0fe3c1bf9a4a7fc88e64967d3f49d0732904bb2db6a270a0f5165d5bb89d813d0f7bf706fd2e2f05ca65555bef31c417efc945f0f6012a14a04f7e2655d79268b2d255214d61626d5298ba1f2b09bbc0baf36a7ef77f9926ada0d26bd674a38b7c14cfefda8845fc26a2361eab2208c3768a79c20b6f82f0ff62a02c3298921d2d2eee4702a8514af847b7d127875ec5200c9047bf34df1edb503680"
        );
        proof[2] = vm.parseBytes(
            "0xf90211a085fdf681967565b2f54236b547e91028fb9e0bc6f627939de2bc3c5dc04726d8a08dcb4920a5b5f001a14f9057a259a861d2c5cd66e247f8bb2fa01e4a137541cba09f0512d2505fbe7d6cb2e22cd7fdd947db739cc14d35da8e12307d9a1c6adf42a02118b731d43a18954150b758dbbf06271f5286cc5fa7766539e7ad10b0443918a0dc0d13b566841dc059d1e44db323fbb84084e23a01d23a4d74f40b82df57dc90a0ac812e1f30e19dabe6dfafe881ee25161d400f6da0cd29b22a0f7156f3cb1d14a014f1f4f7beac6bfc5da18cffec60ac7532740b47472be10056f6a0eb01167132a056a5537ef3e14d4135b68043c51d03c2ffa4e119b9837a97f6cd264b252a3cf1a00b2699e23172108f8c59628899c64fe8fe2a5b1e53fd55c7cc297f10c3fa68fea0a5f96ed58571a55f7182ff95cde35b7f96a46a9e2ac7c8e934d19c0471bc32a4a07f35be95aae9510d3f3f0db8cb3452c2b3aa775a7f1cc86c482b135a6498d16da09902b85f418a49ec5cef8430681c93c139b0335c922855765865399df5032d55a0bc0be2f840dc2806c8c8daa2a782e7e5e67229f6538d930f7e162f4b75a7432ea017b4b55d60aeb07a5e950e97de32d0f2fd8ca3fe4e9d06a84a10468d53feca17a065f779d3a19a6f189e1338f3e645587c1b39dcd2745fab450820aae1d8ea7db5a038e51a877920b78379f4fdb4d0b6d6982b5f03503cb893c40f42ac071ba8da6580"
        );
        proof[3] = vm.parseBytes(
            "0xf90111a02173a5d857d79adcfff1ec8556b40af697b1912f5d0c6d73027f9d0cecb84e7aa024f3f3032534b883b16d930c95df99c736858560833d51e43786c71547dc236da02c55d50fe3347e6c839f714d941707d2a0afdb313cf5fb52322556e8efe0fe73a02aba74b19422078ee7ff7d952585feebc87d3bedad530c5841c79b20429d73ad80a038aba2e7e4a552aafe8850f9b4640b1119f0cca00f40836223bcbc9a35af45c880a08bf413e862b38c439608685130a064d451fc253e96022550f830cb54fcae3647a09c15290acde710bcb0bc98f1dd3e577cd3eda76c2cf58bf629b961aa50f83f9c8080808080a0c313919358e87c8d25732bbf84dbefc6242d93c0564b53dec3981f64415d0a758080"
        );

        bytes32 root = vm.parseBytes32(
            "0x50dafcdb871b08ab8ba2c484725ab1d7a3b3ad7dab22a1d3820c9b3dcee05f60"
        );
        SecureMerkleTrie.verifyInclusionProof({
            _key: key,
            _value: hex"01",
            _proof: proof,
            _root: root
        });
    }

    function validate2() public {
        bytes memory key = vm.parseBytes(
            "0x840b6273674656c6184ba603cb58f6120805123c1596e45643900c0a8785cf49"
        );
        bytes[] memory proof = new bytes[](6);

        proof[0] = vm.parseBytes(
            "0xf90211a077d8a4b25135114781829a4c8fb751245f5cf5d07c10c27658ff1856a8f7d210a0fdafe65f27e2a0eeb60733c87f0c41bc6a5515fe2b51156ac6627547510e377aa0b891016564f1db8fae99184f8c903f81759bfa7248a652ef1e1c889be03f5ab5a0cdf3f98ee864db2fa0f9f5e608061b32ca522a1b9d335584f2b25dfc7d2d66fea01b862269594b54c264064a6d092d9a84bb3340c96c6868bbf9665740ee7e9791a01a12563ffb6b991e6865a005eff7f757718eedc00e9aaba0c610c629d3b3c122a0ddbf96e9f05506e04a2057bb8bef96aeb91e8540c5b61c52bb2447884e787a48a006181edc4e534100404206545d18dc9ec9f811ad60555186a398c1186f4f78eba0bf18115a0603bbaa2b998544614dbb0049887ab7747bb9f4f7fdfff8e934a99da0060d33429607c901b4aae7371853ae54c9f75b754aeb8d7442e65a96139fc604a02adb27c564c178ed89f49a84ae924cf5b09cdf6ffe96eb392c49f1fddd24aed4a0b6bcc690bcdcd4d054ea5597c74e1a0904939b5d31134c4c413f699e6317c2d5a06cce72af77b5b6262a8da84c1f40f219d2a6260870c04fe99935fe1beb14106aa0f5fe386a7ec0c1f4175b14ad4014e54453b344935461f38f583b6d33b10e8c20a03a7a97765985296e6502f736c3232989a9e64395069aac719d75b7a072af7efca0782118fc9f94fcd1cfeeb03145ba8b3e8dba7a3f315c811ee82e4d8360e048d580"
        );
        proof[1] = vm.parseBytes(
            "0xf90211a09862fbdb1e918dfd196a997702f0cadba5516efa5dd1ef33199f77489b028a60a0760d534355eeec4334818831f8226cbba2f0af8293838a0eac9c2799d3d98614a055ed17baf1d5bea811f3b9c8567e183dad929a5032ae281ac0f095a9cd650d95a07ccf91d96197645f982d41dc6a687447f051128dafbc4571947f811dd8026072a04e5e6620e3d75788185332ab9df705bcc8b90aa86317066fb7721a702acea648a0e076323dd19aef6599b346a6b8abf901851a22672ed4d2e30d1f8cc5eefe9f6aa06d6d6d2ef75e6d5dbb2b86ca0eb52776eddb867a43a41470c9f2e6bc5584ca32a053416a71fbb3de1198d305da74bbeeb251fc6d6ec817163ac637260a1055940da0432d165de25734aff135000d4549478a90e3ce3e575adf068e328a027ca74ce5a00a4a7c1ff5ab6b64537da2b2989a55d67ba0b32d96ff9821a78bca6f2d8039aba01340523b33cd09ccc68c2832e9c0ddc8cb400012fd05366954ecd7b8952e08f1a092cdbb74d2cad1d6717faee25b7297e01308ca529a2fb5c8d69682eda4be8db6a02f022d2c406cf96c1d2f0b55f5aa334da99f410ba3f73ef442140f8ddf9eee9ca05445bba73271e6c50a19e108239c596028a9982562a68683a9ba6f98418497e5a0708a664af317605cc60b0fcc6b4aaecad29c7c257c337ed9ce9f77ed796bc43fa044befcf63cf1b4d5a976a080194190036b533f37dfa09a581b8ba5a2486a271880"
        );
        proof[2] = vm.parseBytes(
            "0xf90211a0e0286e28dd172f633acb90f960f28272e5e187df51d880b4921062a3168b8597a033ab3c28077abd530a8fee4ff230071cf82dd31a3af9a4b1741c576545d16ad1a07e6b7bcf146ade8c33a9c787be60f24a56b88d08ee39126fd9fc61568851aaa7a01a2c05a204f25bdaa054f1549847706cd7abd8b61053f75b4a575e770231a290a0102c8d77caf3c62697444d88746498e64936a74f4ff2c0f71effc44dfe08438ea0e2e9d78f1dd3306c87cae7ce6a82dcb1fe55dd839723920c1af0455595a46ca9a0c52796cd93d216359c3a35f68c0844c5ca0bacc4c9fd0d0c1ba8eef1858d880fa014e4877bea5a7f185a2ae7210e596f468f58a79fe788e82a6dc7e35f951740d3a02faccce9dcfd1b378fe6ca1e9518cc168326d87fc18d4acd4a3074ceaf8fef37a0ab3517a5e69665d6fe73443b442a00bbe979882b39d4ccc6c7ffb66e3aa8dea1a038e5fd1c712cd1c85988205639022bbe18570845be1172bbfebf86a6593329c5a00a44f907ff7acb2f5b40703091896245b6872124b75a1c2d695f4ae4b96f96d8a0746cc0972dbea4c7ee94a5685d57ed4162cead02fc14cf303adf6fa70ea7d6b2a0924536e47ef5bcc2714149cb7502d0c294b4a26ba48d7289d7239b254e67abaea067cedb8ccb2ee5f3da9c6d8f9453172522cb89c23498e19897c268fedb66a2d2a0e59c7831ed771db15ad21b15b1ea44892c474101dfdd2154366a0d84f5318bf080"
        );
        proof[3] = vm.parseBytes(
            "0xf90171a008d05934713062976f56d0cfff5bd1780d5513807650f606f5c52f344c84deaa80808080a0605c37369cf99b3ec234507fc7beab16b83772fb7517b1bc72741b1197b4ca81a0488fb509daf3d7d47bbed0f625c09bd0b37c4a897389dac7ed8cd35484bacf17a052d349390feb41deba0110e7156eee450c99df519a4422056637a78245626766a0bc93622f3d43537010ea621182e375c2bda0f70350dcc2f3b9ca9d299748ffa9a0ae9de4a9eb6acc854f94269b3ccdb7d3a73d614e79c5c44bedc320256e0c2f71a02fb5d304c3a2431e64d1819b0185ac96ec6f5fadbaf8f461755eb688bc17fc4980a0c1f95bc04e8f3175993d25e04489f42b27a2d3bfa7e8562a83cd2b204c07daeda0139f467efac7d7305e914a2a0c2fb3b62dfd1b293316a9ec79084a6d0162204ea0b19847238d0e01ab3d7b3581d948100d4d9dcc23971dc4c790d50e8023bc15caa06e20e94b65a5054d8bd41a4af84475a603eefe6e138d93941af1bdbff3af052080"
        );

        proof[4] = vm.parseBytes(
            "0xf87180808080808080a0962dfee4fc25391109333eaf9e3c19fbedd90cb099291821adbc5a5e78f6502c8080808080a0fe16636adf43096eb7a4d8580cd246b91e3d1ada63f2b7bab694f54e9c7a00bc80a03fe7d646d245cffe33edfb25503dfd013212c13c9f994fef4a39a19440d403e080"
        );

        proof[5] = vm.parseBytes(
            "0xe09e38efd66e800807634012b75d9156a80ceed8bef39314ab6b91056828c84d01"
        );

        bytes32 root = vm.parseBytes32(
            "0xfc009bbfc480fff6246d06a5fd92269eb8cbbe66a062968942436eb81251656d"
        );
        bool x = SecureMerkleTrie.verifyInclusionProof({
            _key: key,
            _value: hex"01",
            _proof: proof,
            _root: root
        });

        console.log("x", x);
    }

    function _getL2Message(
        bytes memory txData
    ) internal returns (bytes memory) {
        (
            uint256 _destination,
            address _source,
            address _nonce,
            uint256 _sender,
            uint256 _target,
            bytes memory _message
        ) = abi.decode(
                _removeFirst4Bytes(txData),
                (uint256, address, address, uint256, uint256, bytes)
            );

        (address from, address to, uint256 amount, bytes memory extraData) = abi
            .decode(
                _removeFirst4Bytes(_message),
                (address, address, uint256, bytes)
            );

        return extraData;
    }

    function abiDecode(bytes calldata _metadata) public {
        (
            IOptimismPortal.WithdrawalTransaction memory _tx,
            uint256 _disputeGameIndex,
            IOptimismPortal.OutputRootProof memory _outputRootProof,
            bytes[] memory _withdrawalProof
        ) = abi.decode(
                _metadata,
                (
                    IOptimismPortal.WithdrawalTransaction,
                    uint256,
                    IOptimismPortal.OutputRootProof,
                    bytes[]
                )
            );
        console.log("bytes");
        console.log(_tx.value);
    }

    function _removeFirst4Bytes(
        bytes memory data
    ) internal pure returns (bytes memory) {
        require(data.length >= 4, "Data must be at least 4 bytes long");

        bytes memory result = new bytes(data.length - 4);

        assembly {
            let src := add(data, 0x24) // Skip the length (0x20) and first 4 bytes (0x04)
            let dest := add(result, 0x20) // Destination starts at 0x20 (after length prefix)
            let len := sub(mload(data), 4) // Adjust length

            mstore(result, len) // Store new length
            for {
                let i := 0
            } lt(i, len) {
                i := add(i, 32)
            } {
                mstore(add(dest, i), mload(add(src, i)))
            }
        }

        return result;
    }

    function tm(bytes calldata tokenMessage) public {
        // (IOptimismPortal.WithdrawalTransaction memory txxx, bytes32 hash) = abi
        //     .decode(
        //         Message.body(tokenMessage).metadata(),
        //         (IOptimismPortal.WithdrawalTransaction, bytes32)
        //     );

        bytes32 hash = abi.decode(
            Message.body(tokenMessage).metadata(),
            (bytes32)
        );
        // console.log("nonce", txxx.nonce);
        // console.log("sender", txxx.sender);
        // console.log("target", txxx.target);
        // console.log("value", txxx.value);
        // console.log("gasLimit", txxx.gasLimit);
        // console.log("data");
        // console.logBytes(txxx.data);
        // console.log("message");

        // (
        //     address sender,
        //     address remoteRouter,
        //     uint256 amount,
        //     bytes memory extra
        // ) = abi.decode(
        //         _removeFirst4Bytes(txxx.data),
        //         (address, address, uint256, bytes)
        //     );
        // console.log("sender", sender);
        // console.log("remoteRouter", remoteRouter);
        // console.log("amount", amount);
        // console.log("bytes");
        // console.logBytes(extra);

        // bytes32 wh = abi.decode(, (bytes32));
        console.logBytes32(hash);
    }
}
