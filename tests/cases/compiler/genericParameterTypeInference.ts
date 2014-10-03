function find<T>(hay: T[], test: (s: T) => boolean ) { return 0; }

function stringIsEmpty(s: string) { return false; }

find([1, 2, 3], stringIsEmpty);
