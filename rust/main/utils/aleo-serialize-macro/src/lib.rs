use proc_macro::TokenStream;
use quote::quote;
use syn::{Data, DeriveInput, Fields};

#[proc_macro_attribute]
pub fn aleo_serialize(_attr: TokenStream, item: TokenStream) -> TokenStream {
    let input: DeriveInput = match syn::parse(item.clone()) {
        Ok(v) => v,
        Err(e) => return e.to_compile_error().into(),
    };

    let ident = &input.ident;
    let generics = input.generics.clone();
    let (impl_generics, ty_generics, where_clause) = generics.split_for_impl();

    let data_struct = match &input.data {
        Data::Struct(s) => s,
        _ => {
            return TokenStream::from(quote! {
                compile_error!("parse_value attribute can only be applied to a struct");
            });
        }
    };

    let fields_named = match &data_struct.fields {
        Fields::Named(f) => &f.named,
        Fields::Unnamed(_) | Fields::Unit => {
            return TokenStream::from(quote! {
                compile_error!("parse_value requires a struct with named fields");
            });
        }
    };

    // For parse_value (from Plaintext -> struct)
    let field_inits = fields_named.iter().map(|f| {
        let fname = f.ident.as_ref().unwrap();
        let fname_str = fname.to_string();
        let fty = &f.ty;
        quote! {
            let #fname = {
                let __field_plaintext = fetch_field::<N>(&value, #fname_str)?;
                <#fty as AleoSerialize<N>>::parse_value(__field_plaintext)?
            };
        }
    });

    let construct_fields = fields_named.iter().map(|f| {
        let fname = f.ident.as_ref().unwrap();
        quote!( #fname )
    });

    // For to_plaintext (struct -> Plaintext)
    // Assumes each field type implements ToPlaintext<N> with:
    //   fn to_plaintext(&self) -> Result<Plaintext<N>>
    // And that Plaintext<N> has a struct-like constructor helper:
    //   Plaintext::from_named_fields(Vec<(impl Into<String>, Plaintext<N>)>)
    // If your API differs, adapt the emitted code inside this method.
    let to_plaintext_field_insertions = fields_named.iter().map(|f| {
        let fname = f.ident.as_ref().unwrap();
        let fname_str = fname.to_string();
        quote! {
            map.insert(Identifier::from_str(#fname_str)?, <_ as AleoSerialize<N>>::to_plaintext(&self.#fname)?);
        }
    });

    let expanded = quote! {
        #input

        impl #impl_generics AleoSerialize<N> for #ident #ty_generics #where_clause {
            fn parse_value(value: Plaintext<N>) -> Result<Self> {
                #(#field_inits)*
                Ok(Self {
                    #(#construct_fields),*
                })
            }

            fn to_plaintext(&self) -> Result<Plaintext<N>> {
                // Build an IndexMap<Identifier<N>, Plaintext<N>> for the struct fields.
                let mut map: ::indexmap::IndexMap<Identifier<N>, Plaintext<N>> = ::indexmap::IndexMap::new();
                use core::str::FromStr;
                #(#to_plaintext_field_insertions)*
                Ok(Plaintext::Struct(map, ::std::sync::OnceLock::new()))
            }
        }
    };

    expanded.into()
}
