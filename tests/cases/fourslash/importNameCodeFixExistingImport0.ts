/// <reference path="fourslash.ts" />

//// [|import { v1 } from "./module";
//// f1/*0*/();|]

// @Filename: module.ts
//// export function f1() {}
//// export var v1 = 5;

verify.codeFixAtPosition(
`import { v1 } from "./module";
import { f1 } from "./module";
f1();`);