fn main() {
    let src = "./src/query/generated/openapi.json";
    println!("cargo:rerun-if-changed={}", src);
    let file = std::fs::File::open(src).unwrap();
    let spec = serde_json::from_reader(file).unwrap();
    let mut generator = progenitor::Generator::default();

    let tokens = generator.generate_tokens(&spec).unwrap();
    let ast = syn::parse2(tokens).unwrap();
    let content = prettyplease::unparse(&ast);

    let p = "/Users/danwt/Documents/dym/d-hyperlane-monorepo/dymension/libs/kaspa/lib/core/src/query/generated";
    let mut out_file = std::path::Path::new(p).to_path_buf();
    out_file.push("codegen.rs");

    std::fs::write(out_file, content).unwrap();
}
