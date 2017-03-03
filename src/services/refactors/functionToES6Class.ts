namespace ts.refactor {
    registerRefactor({
        canBeSuggested: true,
        description: "Convert ES5 function to ES6 class",
        getCodeActions: undefined,
        isApplicableForRange: undefined,
        isApplicableForNode: isApplicableForNode,
        refactorCode: 1
    });

    function isApplicableForNode(node: Node): boolean {
        
    }
}