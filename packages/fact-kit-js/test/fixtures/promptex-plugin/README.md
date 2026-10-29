# promptex-plugin

Seven declaration files copied unchanged from the `dist/` of the npm package `promptex-js` 1.5.2 (license
MIT OR Apache-2.0): `config.d.ts` and the six files it imports, `adapter.d.ts`, `content.d.ts`, `diag.d.ts`,
`ir.d.ts`, `plugin.d.ts` and `registry.d.ts`.

`test/convert-recursive.test.ts` converts `Plugin` and `ConfigUnit` from them. `Plugin` has methods, properties
whose type is a function, and generic types that refer to themselves, such as a `Promise` returned by a method.
