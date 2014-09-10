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
