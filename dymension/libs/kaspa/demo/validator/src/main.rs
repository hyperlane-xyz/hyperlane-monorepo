pub mod e2e;
use e2e::create_new_validator;

fn main() {
    // TODO: move elsewhere
    let v = create_new_validator();
    println!("{}", v.to_string());
}
