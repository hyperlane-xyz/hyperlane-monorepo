fn main() {
    abigen::generate_bindings_for_dir("../hyperlane-ethereum/abis", "./src/contracts", abigen::BuildType::Ethers);
}
