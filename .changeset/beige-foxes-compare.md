---
"@hyperlane-xyz/utils": patch
---

Remove generic type parameters from JSON/YAML read functions (readJson, tryReadJson, readJsonFromDir, readYamlOrJson, yamlParse, readYaml, tryReadYaml, readYamlFromDir). These functions now return the implicit `any` type, avoiding false impression of type validation. Also use stringifyObject in writeJson for proper BigNumber serialization and rename removeEndingSlash to removeTrailingSlash.
