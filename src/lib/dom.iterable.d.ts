/// <reference path="lib.dom.d.ts" />

interface DOMTokenList {
    [Symbol.iterator](): IterableIterator<string>;
}

interface FormData {
    /**
     * Returns an array of key, value pairs for every entry in the list
     */
    entries(): IterableIterator<[string, string | File]>;
    /**
     * Returns a list of keys in the list
     */
    keys(): IterableIterator<string>;
    /**
     * Returns a list of values in the list
     */
    values(): IterableIterator<string | File>;

    [Symbol.iterator](): IterableIterator<string | File>;
}

interface NodeList {
    /**
    * Returns an array of key, value pairs for every entry in the list
    */
    entries(): IterableIterator<[number, Node]>;
    /**
      * Performs the specified action for each node in an list.
      * @param callbackfn  A function that accepts up to three arguments. forEach calls the callbackfn function one time for each element in the list.
      * @param thisArg  An object to which the this keyword can refer in the callbackfn function. If thisArg is omitted, undefined is used as the this value.
      */
    forEach(callbackfn: (value: Node, index: number, listObj: NodeList) => void, thisArg?: any): void;
    /**
      * Returns an list of keys in the list
      */
    keys(): IterableIterator<number>;

    /**
      * Returns an list of values in the list
      */
    values(): IterableIterator<Node>;


    [Symbol.iterator](): IterableIterator<Node>;
}

interface NodeListOf<TNode extends Node> {

    /**
    * Returns an array of key, value pairs for every entry in the list
    */
    entries(): IterableIterator<[number, TNode]>;

    /**
      * Performs the specified action for each node in an list.
      * @param callbackfn  A function that accepts up to three arguments. forEach calls the callbackfn function one time for each element in the list.
      * @param thisArg  An object to which the this keyword can refer in the callbackfn function. If thisArg is omitted, undefined is used as the this value.
      */
    forEach(callbackfn: (value: TNode, index: number, listObj: NodeListOf<TNode>) => void, thisArg?: any): void;
    /**
      * Returns an list of keys in the list
      */
    keys(): IterableIterator<number>;
    /**
      * Returns an list of values in the list
      */
    values(): IterableIterator<TNode>;

    [Symbol.iterator](): IterableIterator<TNode>;
}
