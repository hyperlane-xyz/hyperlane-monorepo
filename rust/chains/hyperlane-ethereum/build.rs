fn main() {
    abigen::generate_bindings_for_dir("./abis", "./src/interfaces", abigen::BuildType::Ethers);
}
