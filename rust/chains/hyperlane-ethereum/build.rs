use abigen::generate_bindings_for_dir;

fn main() {
    generate_bindings_for_dir("./abis", "./src/contracts");
}
