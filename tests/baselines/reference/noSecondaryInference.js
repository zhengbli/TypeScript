//// [noSecondaryInference.ts]
function isTruthy(s: any) {
    return !!s;
}

function filter<T>(a: T[], predicate: (e: T) => boolean) {
    return a.filter(predicate);
}

var x = [1, 2, 3];
var j: string[] = filter(x, isTruthy);


//// [noSecondaryInference.js]
function isTruthy(s) {
    return !!s;
}
function filter(a, predicate) {
    return a.filter(predicate);
}
var x = [1, 2, 3];
var j = filter(x, isTruthy);
