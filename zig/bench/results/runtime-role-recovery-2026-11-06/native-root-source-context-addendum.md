# Native root context forwarding addendum

After strict root classification, Factory.metadataInner now assigns source.options.app_context = root_app_context before either cached or uncached Builder path. The same Source.options value is copied by native forks, so downstream svm()/inline child dispatch can inherit the resolved root label. Classification remains once; no new I/O or operation/queue context changes.

Focused classifier/actual native cached metadata/fork isolation:16/16 passed, zero skips. Command remains app-context-command.json; log native-root-source-context-tests.log. zig fmt --check passed for factory.zig.

The actual known-validator SVM composite leaf/full-latest regression belongs to the external metadata owner alongside Source.svm forwarding and Sealevel implementation. This addendum does not claim that pending work complete. Role recompilation after the separate Source HTTP500 codec work remains the parent integration gate.

Original manifest hashes describe the preceding accepted recovery snapshot. New factory.zig SHA256: `9f8c7b82f152834bd3a6134ee66eab9` + `b3764ece4fa2aa0323c377f4ff0a028` + `6b`.
