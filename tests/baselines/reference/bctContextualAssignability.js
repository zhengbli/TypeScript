//// [bctContextualAssignability.ts]
class Animal {
    name: string;
}
class Dog extends Animal {
    name: any;
    woof() { }
}

var zoo: Animal[];
zoo[0] = new Dog(); // OK
// Desired: no error
zoo = [new Dog(), new Animal()];  // Error, cannot convert {}[] to Animal[]

class Cat extends Animal {
    meow() { }
}

zoo[0] = new Dog(); // OK
zoo[1] = new Cat(); // OK
zoo = [new Dog(), new Cat()]; // Desired: No error
zoo = ([new Dog(), new Cat()]); // Still an error

enum E { }
class Base {
    e: E;
}
class Derived extends Base {
    e: number;
    x: string;
}

var b: Base[];
b = [new Derived(), new Base()]; // Desired: no error

enum E { a }
var x: { e: E }[];
x[0] = {e: 0, s: ''}; // OK
x = [{e: 0, s: ''}, { e: E.a }]; // Desired: no error


//// [bctContextualAssignability.js]
var __extends = this.__extends || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    __.prototype = b.prototype;
    d.prototype = new __();
};
var Animal = (function () {
    function Animal() {
    }
    return Animal;
})();
var Dog = (function (_super) {
    __extends(Dog, _super);
    function Dog() {
        _super.apply(this, arguments);
    }
    Dog.prototype.woof = function () {
    };
    return Dog;
})(Animal);
var zoo;
zoo[0] = new Dog(); // OK
// Desired: no error
zoo = [new Dog(), new Animal()]; // Error, cannot convert {}[] to Animal[]
var Cat = (function (_super) {
    __extends(Cat, _super);
    function Cat() {
        _super.apply(this, arguments);
    }
    Cat.prototype.meow = function () {
    };
    return Cat;
})(Animal);
zoo[0] = new Dog(); // OK
zoo[1] = new Cat(); // OK
zoo = [new Dog(), new Cat()]; // Desired: No error
zoo = ([new Dog(), new Cat()]); // Still an error
var E;
(function (E) {
})(E || (E = {}));
var Base = (function () {
    function Base() {
    }
    return Base;
})();
var Derived = (function (_super) {
    __extends(Derived, _super);
    function Derived() {
        _super.apply(this, arguments);
    }
    return Derived;
})(Base);
var b;
b = [new Derived(), new Base()]; // Desired: no error
var E;
(function (E) {
    E[E["a"] = 0] = "a";
})(E || (E = {}));
var x;
x[0] = { e: 0, s: '' }; // OK
x = [{ e: 0, s: '' }, { e: 0 /* a */ }]; // Desired: no error
