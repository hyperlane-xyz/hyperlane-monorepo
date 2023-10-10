#cd router && aptos move compile
#cd ../examples && aptos move compile
#cd ../validator-announce && aptos move compile

# To make use of aptos cli
export PATH="/root/.local/bin:$PATH"

function aptos_init() {
  aptos init --assume-yes --network custom --rest-url "http://0.0.0.0:8080/v1" --faucet-url "http://127.0.0.1:8081" --encoding hex --private-key-file $1
}

SHELL_DIR_PATH="$(dirname $0)";
PWD_DIR_PATH="$(pwd)"

FAUCET_URL="http://127.0.0.1:8081"
REST_API_URL="http://0.0.0.0:8080/v1"

LN1_EXAMPLES_ADDRESS="0xd1eaef049ac77e63f2ffefae43e14c1a73700f25cde849b6614dc3f3580123fc"
LN1_IGPS_ADDRESS="0xc5cb1f1ce6951226e9c46ce8d42eda1ac9774a0fef91e2910939119ef0c95568"
LN1_ISMS_ADDRESS="0x6bbae7820a27ff21f28ba5a4b64c8b746cdd95e2b3264a686dd15651ef90a2a1"
LN1_LIBRARY_ADDRESS="0xe818394d0f37cd6accd369cdd4e723c8dc4f9b8d2517264fec3d9e8cabc66541"
LN1_MAILBOX_ADDRESS="0x476307c25c54b76b331a4e3422ae293ada422f5455efed1553cf4de1222a108f"
LN1_ROUTER_ADDRESS="0xafce3ab5dc5d513c13e746cef4d65bf54f4abdcb34ea8ab0728d01c035610e3d"
LN1_VALIDATOR_ANNOUNCE_ADDRESS="0xa4a4eb4bab83650ba62cabe9ce429ad021b29c12f2fbf808768838255c7e191d"

LN2_EXAMPLES_ADDRESS="0xb2586f8d1347b988157b9e7aaea24d19064dfb596835145db1f93ff931948732"
LN2_IGPS_ADDRESS="0xea7d568d0705450331a8f09fd1c823faec91f4ef1c7e6ed4b12c0c53d0c08bc8"
LN2_ISMS_ADDRESS="0x39a36a558e955f29f60f9e7ad7e391510fcd6a744d8aec9b86952106bfc3e5e2"
LN2_LIBRARY_ADDRESS="0xc29e4ea7972150a5f3bd6531eba94907ce2be3b47eb17eaee40d381d2fd9122c"
LN2_MAILBOX_ADDRESS="0xd338e68ca12527e77cab474ee8ec91ffa4e6512ced9ae8f47e28c5c7c4804b78"
LN2_ROUTER_ADDRESS="0xd85669f567da6d24d296dccb7a7bfa1c666530eeb0e7b294791094e7a2dce8e3"
LN2_VALIDATOR_ANNOUNCE_ADDRESS="0xce1f65297828eaa6e460724a869317154f05cdde26619c0e5c0ca23aac3f69c7"

################# Fund contract signers and compile & publish contracts ####################
function fund_and_publish() {
  cd $PWD_DIR_PATH
  cd ../$1
  aptos account fund-with-faucet --account $2 --url $REST_API_URL --faucet-url $FAUCET_URL
  aptos move publish --url $REST_API_URL --private-key-file $3 --assume-yes $4
}

LN1_ADDRESS_MATHING="--named-addresses hp_library=$LN1_LIBRARY_ADDRESS,hp_validator=$LN1_VALIDATOR_ANNOUNCE_ADDRESS,hp_isms=$LN1_ISMS_ADDRESS,hp_igps=$LN1_IGPS_ADDRESS,hp_mailbox=$LN1_MAILBOX_ADDRESS,hp_router=$LN1_ROUTER_ADDRESS,examples=$LN1_EXAMPLES_ADDRESS"

fund_and_publish "library" $LN1_LIBRARY_ADDRESS "../e2e/aptos-test-keys/localnet1/library-keypair.json" "$LN1_ADDRESS_MATHING"
fund_and_publish "validator-announce" $LN1_VALIDATOR_ANNOUNCE_ADDRESS "../e2e/aptos-test-keys/localnet1/validator-announce-keypair.json" "$LN1_ADDRESS_MATHING"
fund_and_publish "isms" $LN1_ISMS_ADDRESS "../e2e/aptos-test-keys/localnet1/isms-keypair.json" "$LN1_ADDRESS_MATHING"
fund_and_publish "igps" $LN1_IGPS_ADDRESS "../e2e/aptos-test-keys/localnet1/igps-keypair.json" "$LN1_ADDRESS_MATHING"
fund_and_publish "router" $LN1_ROUTER_ADDRESS "../e2e/aptos-test-keys/localnet1/router-keypair.json" "$LN1_ADDRESS_MATHING"
fund_and_publish "mailbox" $LN1_MAILBOX_ADDRESS "../e2e/aptos-test-keys/localnet1/mailbox-keypair.json" "$LN1_ADDRESS_MATHING"
fund_and_publish "examples" $LN1_EXAMPLES_ADDRESS "../e2e/aptos-test-keys/localnet1/examples-keypair.json" "$LN1_ADDRESS_MATHING"

LN2_ADDRESS_MATHING="--named-addresses hp_library=$LN2_LIBRARY_ADDRESS,hp_validator=$LN2_VALIDATOR_ANNOUNCE_ADDRESS,hp_isms=$LN2_ISMS_ADDRESS,hp_igps=$LN2_IGPS_ADDRESS,hp_mailbox=$LN2_MAILBOX_ADDRESS,hp_router=$LN2_ROUTER_ADDRESS,examples=$LN2_EXAMPLES_ADDRESS"

fund_and_publish "library" $LN2_LIBRARY_ADDRESS "../e2e/aptos-test-keys/localnet2/library-keypair.json" "$LN2_ADDRESS_MATHING"
fund_and_publish "validator-announce" $LN2_VALIDATOR_ANNOUNCE_ADDRESS "../e2e/aptos-test-keys/localnet2/validator-announce-keypair.json" "$LN2_ADDRESS_MATHING"
fund_and_publish "isms" $LN2_ISMS_ADDRESS "../e2e/aptos-test-keys/localnet2/isms-keypair.json" "$LN2_ADDRESS_MATHING"
fund_and_publish "igps" $LN2_IGPS_ADDRESS "../e2e/aptos-test-keys/localnet2/igps-keypair.json" "$LN2_ADDRESS_MATHING"
fund_and_publish "router" $LN2_ROUTER_ADDRESS "../e2e/aptos-test-keys/localnet2/router-keypair.json" "$LN2_ADDRESS_MATHING"
fund_and_publish "mailbox" $LN2_MAILBOX_ADDRESS "../e2e/aptos-test-keys/localnet2/mailbox-keypair.json" "$LN2_ADDRESS_MATHING"
fund_and_publish "examples" $LN2_EXAMPLES_ADDRESS "../e2e/aptos-test-keys/localnet2/examples-keypair.json" "$LN2_ADDRESS_MATHING"

################# Fund signers ####################
function fund() {
  aptos account fund-with-faucet --account $1 --url $REST_API_URL --faucet-url $FAUCET_URL
}

LN1_VALIDATOR_SIGNER_ADDRESS="0x21779477148b80ec9e123cc087a04ebbfb4a9de0ba64aa8f31510a0266423bb9"
LN1_RELAYER_SIGNER_ADDRESS="0x8b4376073a408ece791f4adc34a8afdde405bae071711dcbb95ca4e5d4f26c93"
LN2_VALIDATOR_SIGNER_ADDRESS="0xef7adb55757d157d1a1f76d5d04806aba4f9099a32260b9356d6dd53c177cd1e"
LN2_RELAYER_SIGNER_ADDRESS="0xcc7867910e0c3a1b8f304255123a4459c0222c78987d628f1effbf122f436b7b"

fund $LN1_VALIDATOR_SIGNER_ADDRESS
fund $LN1_RELAYER_SIGNER_ADDRESS
fund $LN2_VALIDATOR_SIGNER_ADDRESS
fund $LN2_RELAYER_SIGNER_ADDRESS
