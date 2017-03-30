//// [emitClassDeclarationWithPropertyAccessInHeritageClause1.ts]
interface I {}
interface CTor {
    new (hour: number, minute: number): I
}
var x: {
    B : CTor
};
class B {}
function foo() {
    return {B: B};
}
class C extends (foo()).B {}

//// [emitClassDeclarationWithPropertyAccessInHeritageClause1.js]
var __extends = (this && this.__extends) || (function () {
    var extendStatics = Object.setPrototypeOf ||
        ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
        function (d, b) { for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p]; };
    return function (d, b) {
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
var x;
var B = (function () {
    function B() {
    }
    return B;
}());
function foo() {
    return { B: B };
}
var C = (function (_super) {
    __extends(C, _super);
    function C() {
        return _super !== null && _super.apply(this, arguments) || this;
    }
    return C;
}((foo()).B));
