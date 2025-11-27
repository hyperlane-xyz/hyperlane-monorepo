extern crate proc_macro;
extern crate quote;
extern crate syn;

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
    let (_orig_impl_generics, ty_generics, where_clause) = generics.split_for_impl();

    // Build impl generics: always add N: Network (struct itself does NOT gain N).
    // It is convention to call the network parameter N.
    let impl_generics_with_n = if generics.params.is_empty() {
        quote!(<N: snarkvm::prelude::Network>)
    } else {
        let params_without_n = generics
            .params
            .iter()
            .filter(|gp| matches!(gp, syn::GenericParam::Type(t) if t.ident != "N"))
            .collect::<Vec<_>>();
        quote!(<N: snarkvm::prelude::Network, #(#params_without_n),*>)
    };

    let data_struct = match &input.data {
        Data::Struct(s) => s,
        _ => {
            return TokenStream::from(quote! {
                compile_error!("aleo-serialize attribute can only be applied to a struct");
            });
        }
    };

    let fields_named = match &data_struct.fields {
        Fields::Named(f) => &f.named,
        Fields::Unnamed(_) | Fields::Unit => {
            return TokenStream::from(quote! {
                compile_error!("aleo-serialize requires a struct with named fields");
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
                let __field_plaintext = aleo_serialize::fetch_field::<N>(&value, #fname_str)?;
                <#fty as aleo_serialize::AleoSerialize<N>>::parse_value(__field_plaintext)?
            };
        }
    });

    let construct_fields = fields_named.iter().map(|f| {
        let fname = f.ident.as_ref().unwrap();
        quote!( #fname )
    });

    // For to_plaintext (struct -> Plaintext)
    let to_plaintext_field_insertions = fields_named.iter().map(|f| {
        let fname = f.ident.as_ref().unwrap();
        let fname_str = fname.to_string();
        quote! {
            map.insert(snarkvm::prelude::Identifier::from_str(#fname_str)?, <_ as aleo_serialize::AleoSerialize<N>>::to_plaintext(&self.#fname)?);
        }
    });

    let expanded = quote! {
        #input

        impl #impl_generics_with_n aleo_serialize::AleoSerialize<N> for #ident #ty_generics #where_clause {
            fn parse_value(value: snarkvm::prelude::Plaintext<N>) -> anyhow::Result<Self> {
                #(#field_inits)*
                Ok(Self {
                    #(#construct_fields),*
                })
            }

            fn to_plaintext(&self) -> anyhow::Result<snarkvm::prelude::Plaintext<N>> {
                let mut map: ::indexmap::IndexMap<snarkvm::prelude::Identifier<N>, snarkvm::prelude::Plaintext<N>> = ::indexmap::IndexMap::new();
                use core::str::FromStr;
                #(#to_plaintext_field_insertions)*
                Ok(snarkvm::prelude::Plaintext::Struct(map, ::std::sync::OnceLock::new()))
            }
        }
    };

    expanded.into()
}
