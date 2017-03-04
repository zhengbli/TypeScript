/* @internal */
namespace ts.refactor {
    registerRefactor({
        canBeSuggested: true,
        description: "Convert ES5 function to ES6 class",
        getCodeActions: undefined,
        isApplicableForNode,
        refactorCode: 1
    });

    function isApplicableForNode(node: Node, context: RefactorContext): boolean {
        switch (node.kind) {
            case SyntaxKind.Identifier:
                return checkIdentifier(node as Identifier);

            case SyntaxKind.VariableDeclaration:
                return checkVariableDeclaration(node as VariableDeclaration);
        }
        return false;

        function checkIdentifier(node: Identifier): boolean {
            if (!isNameOfFunctionDeclaration(node)) {
                return false;
            }

            const checker = context.program.getTypeChecker();
            const symbol = checker.getSymbolAtLocation(node);
            return isClassLikeSymbol(symbol);
        }

        function checkVariableDeclaration(node: VariableDeclaration): boolean {
            const initializer = (node as VariableDeclaration).initializer;
            if (initializer && initializer.kind === SyntaxKind.FunctionExpression) {
                const variableName = (node as VariableDeclaration).name;
                const checker = context.program.getTypeChecker();
                const symbol = checker.getSymbolAtLocation(variableName);
                return isClassLikeSymbol(symbol);
            }
        }

        function isClassLikeSymbol(symbol: Symbol) {
            return symbol && symbol.members && symbol.members.size > 0;
        }
    }

    // function getCodeActions(diagnostic: RefactorDiagnostic, context: RefactorContext): CodeAction[] {
    //     const checker = context.program.getTypeChecker();
    //     const sourceFile = context.boundSourceFile;
    //     const token = getTokenAtPosition(sourceFile, diagnostic.start);
    //     const ctorSymbol = checker.getSymbolAtLocation(token);
    //     const ctorDeclaration = ctorSymbol.valueDeclaration;

    //     const changeTracker = textChanges.ChangeTracker.fromCodeFixContext(context);
    //     let ctorBody: Block;
    //     let ctorName: Identifier;
    //     switch (ctorDeclaration.kind) {
    //         case SyntaxKind.FunctionDeclaration:
    //             ctorBody = (<FunctionDeclaration>ctorDeclaration).body;
    //             break;
    //         case SyntaxKind.VariableDeclaration:
    //             const initializer = (<VariableDeclaration>ctorDeclaration).initializer;
    //             if (initializer && initializer.kind === SyntaxKind.FunctionExpression) {
    //                 ctorBody = (<FunctionExpression>initializer).body;
    //             }
    //             break;
    //     }

    //     const newNode = createClassDeclaration([], [], ctorName, [], [], []);        
    //     changeTracker.replaceNode(sourceFile, ctorDeclaration, newNode);

    //     return [{
    //         description: "Test",
    //         changes: changeTracker.getChanges()
    //     }];
    // }
}