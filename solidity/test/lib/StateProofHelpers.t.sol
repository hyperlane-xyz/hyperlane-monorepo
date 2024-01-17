// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
import {Test} from "forge-std/Test.sol";
import "../../contracts/libs/StateProofHelpers.sol";

/**
 * @title Test of StateProofHelper
 * @notice This test uses https://www.quicknode.com/docs/ethereum/eth_getProof Given:
 * address: 0xc005dc82818d67AF737725bD4bf75435d065D239 (Mailbox on mainnet)
 * storageSlot: 0x6A (slot for Mailbox.deliveries)
 * blockNumber: 1221E88 (19013256)
 * stateRoot: 0x46bdf4dd846f5342e246c2d5a1d321750f9f0937f4cb1de57bef56dea23c89f6 (sourced from https://etherscan.io/block/19013256)
 *
 * To query eth_getProof:
 * curl https://docs-demo.quiknode.pro/ \
 * -X POST \
 * -H "Content-Type: application/json" \
 * --data '{"method":"eth_getProof","params":["0xc005dc82818d67af737725bd4bf75435d065d239",["0x4374c903375ef1c6c66e6a9dc57b72742c6311d6569fb6fe2903a2172f8c31ff"],"0x1221E88"],"id":1,"jsonrpc":"2.0"}'
 */
contract StateProofHelpersTest is Test {
    uint256 constant DELIVERIES_SLOT = 106;
    address constant mailboxAddr = 0xc005dc82818d67AF737725bD4bf75435d065D239;
    bytes32 constant stateRoot =
        bytes32(
            0x46bdf4dd846f5342e246c2d5a1d321750f9f0937f4cb1de57bef56dea23c89f6
        );
    bytes[] accountProof;
    bytes[] storageProof;

    function setUProofs() public {
        // Account Proof
        accountProof.push(
            hex"f90211a0867c5349d2a1072808cdfa545d6cabda6f254580fcb39b438c3eccf775c189cea0caee5ec00eb09ba1c7dc6f75ae281f5971fc28b65be01b31794e8b65c7977e29a0707f3921dd60dbfbfad2ca1034f4af8df31930669e43d7319cc4588c95a003f8a0e7b7b8731e9faf6b84298b239c6ebd2686fd6335f8084f30b5b09af4b37ae43fa08d29aebea721caf31b53413bcc3fae6da577ba12969208a2dec4a73f6e286302a0c7f68167cee9c2a6558c94d88d3b44a43d70da5f095e00aa08060b5f97b94ed6a00e2a88861de09294096d866a51c96d7cb362ff285e139b6e8377aa1942f7a9c6a00cfbdc838b4d531086188be0a10a533668612fb980dd1842d52a35535848770aa0ab9d3c876e5002755d60de8778aa14036350aff51d3ec5622267aa22303e66a8a08ae78abfe9b24a98e064ecbc5d8f98915fd05a05df2a7b96d50e3a6ed204d4a3a0cb011b885b17e332de1c2c5d320dbe71c0774a932ea23d2e7cbc97c430b0c4caa09d6839f9c6d34e8fa3a5a464c863301c71aecba0a75ab8be8ffe55a75a496662a0bf194d46c580f4ae738a3dfd4268da8029f6fe6730dd980cda66232f62321687a0c8137eed6aa1c9ab63a5136bbaff4c2b51fdd8e579d1fd4db3fc96ff5adbf24ea078f4943b9cd456fbb237656683f300c8875c647d3a64ee92b363bd060a47b8c8a0ed6eea5554aaf2a8326b615c18c8667b8e0fdc6949f5ce2f85199969b745554d80"
        );
        accountProof.push(
            hex"f90211a03a9e226a236b138b937597eca91c5253a1491aaedbf91646388637f99feae1ffa086fb35aa37e4a382d79dd5ce9fe9c07546980e7846fe4fa7343579cabbfdc87ea0f52448ace45ecff774872f1a5f22706acbe766c15ac034a16006ad6da92a4036a0d37e6221951b76ac7882f7936aedba5bc344096547d0b5dd83dbbb46df86b5d4a056758332eb79286d404bbfe00723e0096cd1f28edab0000f0aa629682008c554a0684ba1a623f8bff38f718b68a32bcfbc8ca867530caf6c9bd37af516e3bacd33a006a3ac4e2fdfc692729d88d0935afb2bca57ce9271ec9257668d0b5958395fe0a0b5c0dec6cee07b690301aa6a609e6d24169f86dd94483559faaf805996b402dea05692dc0f728021f65656ed1045beb1f080850b6356011a49c2faca4534cc3fb5a0a1db94caed363dcc75c2f1084b4ebb136a7b267e8295997edba32e6f55917e15a0d12dabd1620df66d63917828c2eb0aa729d07e7ac1c43444a604753c378f0864a08fe30a6d1e6b93daabbf20af6c7bd68772a0773e71a6082ba8635c81dcc61c14a065ef9311478910782072f3c466cce375ff6adf78ef3fe329263bb9f2a6f24b37a0ba3d42561bbe5d78a26a687cdc97b4dc4a09678294221090c5e7acede940f411a0837e07ad0cb1d36fbeb2ba31bea3cc09f0f945e2112a76e2d79766cf382bdf37a090c88710d2c78e1d78d95b0ddd7366b73ce881a28ef496615e507323e1600de280"
        );
        accountProof.push(
            hex"f90211a064a8d8ae2d93405cdf78cc49f372539ccaeb82f23aa405b4492c65cc40a85fc7a0c6a5ec1ffd049e4ffd1acd8f5a0ac28e24524178d107eadc97fe2b2cf7bf172aa0024c5ea3d0355cd53a8d18abf373eb28c899acf3d25cbaa29a14af36845994bca00cd496b489d83092bc043ca232fb93bc06b1caea9cb91e0954abecdcfdb3cc9ba069b6f404fe28873271a9e90231f8510716c1a71be07af1da40bcd0e5824e4839a001fa604d1217906ac12b6211c79470c75adf8eca9d7d4fe95949bdc6c2f30cdda03463030c40503322238d5b518ac2c4e98bb92987f497aae4c71032ec5fce072ba020255abd92124bc3925f9287aef4ed0a5da3825bbe11bf2824e9b5b62c08cd1aa00d36d568fbc7730d89ecd06ec5e274e561a1fc48a8a407ef8b30ec84faaf5520a0bdf6ebffdbe619c08c471be06e8ab0725d70baadd98e88014676ae9279ef47f2a0dfe035e8ea27dfeb140ed48366d003e1d2df4d855980ee75a24665907f3a0165a0a59173b7db2dfc796cd8b3d3e7d4e2c8221b6e5bebca0cde1b124d1d74a8d2b0a003f09f28070672fcbb321304067ebfbb256d3aa644f3a2d23474941a88cc6275a0653adbd9e5ad084ee5250caa669002f575e498f846f45a4fdfe07c9db9beed8ba08154eaa3cb53f30a5ee2b6b4a71f7827598f810583485f9000204abc9584f432a0e9494312c952a1f664e1e651d15d94eadd8b2a4c58e09233bed490a4c1e1473080"
        );
        accountProof.push(
            hex"f90211a00250a13fb9882aeaafc872b3464c39303580d01de8d225815760387e8adabdc8a06e8fe2a3c2c0b64536441edfd35a0125831c94dd9f54b8ddff2e20f522f97ceea097a1db2e28d2fccfde292f3ad2f14956cc05b7e090f24f9a98c69c974fe5ae8fa093917088e88c62b44fdcefc21b0a9f16b9a002495dc1e47b9d3eb0b7da560492a0700b6ff2715797a312ffc4d9340cb763e4d0ff16b8909b4acfbc78b3e515994fa0cefe453b7a13bdc22477df419cb7f8227a0a5bd9f0856570bbf2571fe0abeea4a0a9764f7874630f1a32d90c9635a4cbf945bb53e0af1e9890d6200bbe0759b879a06081322e3f0246a7586ce3831684ffac2bc5f98c66232b31b335945c94d77f56a0d9279400de6941c765cb67e9b7aef5fd64ffb3187c986deede44f51b5e36cd0fa086f6ed8b83b5d208599b853a0010e0467a3b20bb62aa2c259e78ae8e2b9459f8a0ba5590d7681857dbe2ff4ed20313cf67d1d6f04aea27e60e902b2263b51246efa0232bccb6938995db3900494c7cc6ef57b0cf8d8890385ff2caf1df6cb9280353a034296a713a50c30ab1043066bfa31b3672da841e0f0306b79f9eaa1c036c8c1da06134d35925fbfac9ec5c7eb2826bec4ea7f36069ab8502e829c546cd7b2ecf81a04ca3cd663a1582f6ef96cb4fba1ff1c1085c2328b6bbb388e83dc513bdcecf9aa06b361b1c0fe480562aeb813b21273e3ff583234776c4f907fd06159ccf2766bc80"
        );
        accountProof.push(
            hex"f90211a0f5ab36b85fed9805bb73feb81072018e58b31fceaa26cdc209fc14734433dfa1a0c90c9b5bb406571f5dbd8f7f5178fd4240d31881c3f004aeb063a1b05ffd884aa0328a867c369d2c6f393a257328758d85c9801592b2e3e543b1a942f3535b91daa0b47ce154078f865fbc4be3f2b8bf1263cb2f09fdb5ea2b50f6e473c275785190a007736eaf919d0587ef211f8df6148a5eff1d352c7032cf1c65b60b39cd434b34a0c552ad4d4cad3fa42826dd045cf106caa7f39261bb7dae0b057571742443d829a0d4d6e96329ee24a7cfbe02786683e47e085d5f1c7d384b69c58317a5a80dfaf4a007d13aa64638e4873f92a10fff6a6144886614a9250376f2395a4460b515ef1ba0a58ff240c922f2cdb3a1b3ca4eecc6e8128d680143ffa8ff31864fed0b53ec0ca0fb606030c208e6f9c463fac960b21a3efeb57c20f8de25284ca24a1409eae3d4a007c5d01e0b4d9cddcd9a8c7e50abd3d570afb1bf14c51449f2b6033a1452337da046db38ce0728cec13be944ecf475637a00bdbe7d818c67bf27372d177bc16f3fa0b8567339b36f95c2c65bca4db5a18b092a5fadc3c62b47a4ffb721218781b08ca078f06c745cb6d2ae7305c117c6a9b0774db6e2f9a65de704d0a4162082ba4763a03d40176b6a99853e40fc7a22dc86a86fbbb527f972007144a8e873afc111486da09841c086f6ff2424ebfd93ffa470bdd00caebcbb993cf4d49f542fa3cf41303c80"
        );
        accountProof.push(
            hex"f90211a0ec99bd6c7a01d1c874bae404d84f7bdc8640bacd6f4a88fd098c21e50831c85da02591cb0510617154cc8894153f0949a47805b745c1a2e6dd0f0aad68e44e67cea010c0a995faa1746ef5755950552f316aedbc2ba066bc1d2b86c420e1979065a7a0b037674b4c18017a9fb623e662afef2e76a712268cfd3e859268a0deaf6db136a068abab23d4c81acaf5d4a05d0d0e35acb343913476b286333fc4e58f69781093a053885fd3585d0a4c61bb44e52528e72129d9373e578352c05ee6b5f960e85743a0dee00e66ba953006eccd264f6a9b5f8f65057a7dea29359b3b7528443cc05d6ba04de67d9969d945ee66abfa24f9bff36249eed971fee6bd275f2efd7bf28d11eca0ef41f05c26883ea2521db48d2069a3f7e34bd2be1a612652095391252122279da0ecd04a0c9ce0e40ea8f33ce5f8d1d90dd90b0fc6b5527d5b6ab0633ed2636e69a0e1a26bb74cc621d5dbbc2c39302f6674bef53e06b4a4bd5ffcb0eed1ff94f471a0b140270915db9846487c0b0787db00bcc8dff766f21277d02ec5ce4f48f07b42a0d3a4fc8aeba0d11ec21bc7528ab79130953450ed459b2707563f8e7035a027f9a01cb9106c66e9a49a739a6decc575cf9a06d08d468bdd3171f28476efd37d141da0107790c75a129e50c118b4c9ed13c22d9f5834b313a7ed08eaf8854e889e1476a0a5712da7f321bb5c95c6a52339d34534553e0d0328c91fba01c1b1db6e06176c80"
        );
        accountProof.push(
            hex"f9011180a08d90f10bad986214196d84095d43136df77e9ec0faada3908d981a76f5caab43a055bc280a9cced422e154daa00c96e58c7a95fdc42b08fa05ae56e02b88c967b08080a0a1185fa36134e63e0f77c9aadb78c31af2af4bfdfe99d117abf7a74b57ee0766a0ad6341a672148c47a8f195cb05debf503de56a0d878f709c4cc9e10621a914fda0686bd0dbae8c690e1a1d166ef37060b8554e7e583ce5d8d34ac3e20ef5e9bec3808080a0f1c5e14d3e7b17933e2fc2b733f3a0d1e2b13e8c81fef923c02b82b06fd36230a032f4ab1d8a543717c0c942cd014acabb4a306cbf2ce048be393a313a71c2ea7380a0e94a27ec03291e973c4b37d127684d86c8aaa7610c93729d12238eef505778768080"
        );
        accountProof.push(
            hex"f85180a01527f87f538922969dbdc6b3b55921b068c365bdbcce4e56b7e658d72ba2d4cc808080808080808080808080a0e5fc8d91841746329349ce80718e40fab2dc556f30b09504d1ba4625364732678080"
        );
        accountProof.push(
            hex"f8669d20d53723059c0487d3de0d1b3a4f4c2dcb2289e3853412b57f31fa6345b846f8440180a0e8ee0076df3bad9943911947bc470049dc9c86d715a1e03bf6e8552089eee773a0f412acae2beb37527f1be3f47a70bc921e02f2f8fe4735333b9b33a356b3c494"
        );

        // Storage Proof
        storageProof.push(
            hex"f90211a038b6bc6668ece7e82157098b372a92dc326b8c28c95279270cbbab1fdc343214a00f405b6bcd010ab469ad94e44680e3bfff97afc821c5eb995e58a3c555020f5fa042f92a6ad228e71fa5d82947bd936060bf48b3ddf8080838868a9c257f04681aa093a6feb490c577eb6143f594d2e77354b0c50219dcbf5859a76268de05c1aa2fa0b57103499934a5c28a2891c4dca45b2cafe0a71d6e81d9fb75c02863c78ab809a07c6af2ae8abd095cee0fe1b6aaec872e6ac93fa5c95800c476e7ab31256ea2baa0d7e0f7418efd49a08370db30013a5ed1e1840334092cac194227f43e470b7d1fa07310b4f9fa4e6b12353b22f7eaeebab4fb462daec2308412f4ca97a7b0256207a0ac6ef22e8e5bb30aa97cf451d01f0bbd33a6ae03e16efd8345dc071b3e4b6a36a0ff13df651e2bbab62e024848dcb785a0a5a023654111066f7949c006c796d547a0eea745230ce770a077c55cfa2e6c40f0bf33ccb64672d91021cc513ea142a5c1a09c695fb4275d22435f93eabbee1c064b68304a13919b98342ba50eebe33e1e9ea021ea99ba3307327fd67816b9c1af17b04ee846a8bc767665d4d3e65195c668aba0b86fc30d1bf151c61694c6f563fb7bc9ea86bff909b2f2d14354e95053689940a0708053148c3bb7bc4a3b4c192393492c78e9961b614d4821d424e921ac6ae15ba0efb2af2632ba93f07bba132ad147e0144b5f6d98799e1426a7c6cef860f6cd1880"
        );
        storageProof.push(
            hex"f90151a085d8fc3fa62760ad1ade0ab424752ecc71007294be300100679089ca6ea5b43ba0039fdb2815a6d3b34df2411d93a92abd883ba11dac491792e442f4c29797b08080a0cd3132b9b1baf41122036762772a400906dbf3c64510485ff1259b677962eb01a055c6b801abea32bef6ab3cdc98f095b31adac788443336fbd7e13085de8ac6268080a0b24f2b7a1d4ef020539ebb156bcff971f64968264d21828cbc73159d89a43edc8080a0806232ea8851f05c592a06c1f6ff3126a4f95c42c5ddd3df6ddbaafb1da77843a0bdcb6f184ab7193daa20f138e3132393821e5bc9e44718b2fd3d5535c4a35c4980a08cf21d7df38a0dfce8c7fd0fd97543e993dcc56291847917be104466d33b79eea0b0683bb95116dcaa30cdef7b5660d026716d9e2eff58a137235a13e5c89f8c0ea0ce968d1c9da76e06b99bc3b9a6c872a12891881c0ed8a4fdca3774b5e99b0e5f80"
        );
        storageProof.push(
            hex"f83ba0202a0a19c3369851dec7bc58b8fa22c633bb6e805227bccaaee30fa3b75f1c3399980121eedc74cae0ecc47b02ed9b9d32e000fd70b9417970c5"
        );
    }

    function setUp() public virtual {
        setUProofs();
    }

    function testStateProofHelpersTest_getStorageRoot_setsDeliveriesValue()
        public
    {
        // Calculate the storage root
        bytes32 storageRoot = StorageProof.getStorageRoot(
            mailboxAddr,
            accountProof,
            stateRoot
        );

        // Calculate the deliveries value
        bytes32 messageId = hex"44EFC92481301DB306CB0D8FF7E5FF5B2ABFFEA428677BC37BFFB8DE2B7D7D5F";
        bytes32 deliveriesSlotKey = keccak256(
            abi.encode(keccak256(abi.encode(messageId, DELIVERIES_SLOT)))
        );
        uint256 delivery = StorageProof.getStorageValue(
            deliveriesSlotKey,
            storageProof,
            storageRoot
        );

        // The result of delivery should not be a null value
        assertTrue(bytes32(delivery) != bytes32(0));
    }
}
