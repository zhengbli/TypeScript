//// [templateStringWithEmbeddedYieldKeywordES6.ts]
function* gen() {
    // Once this is supported, yield *must* be parenthesized.
    var x = `abc${ yield 10 }def`;
}


//// [templateStringWithEmbeddedYieldKeywordES6.js]
function gen() {
    // Once this is supported, yield *must* be parenthesized.
    var x = `abc${}def`;
}
