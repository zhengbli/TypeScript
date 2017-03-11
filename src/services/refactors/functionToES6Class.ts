/* @internal */
namespace ts.refactor {
    registerRefactor({
        canBeSuggested: true,
        description: "Convert ES5 function to ES6 class",
        getCodeActions,
        isApplicableForNode,
        refactorCode: 1
    });

    function isApplicableForNode(node: Node, context: RefactorContext): boolean {
        if (!isSourceFileJavaScript(context.boundSourceFile)) {
            return false;
        }

        const checker = context.program.getTypeChecker();
        const symbol = checker.getSymbolAtLocation(node);
        return isClassLikeSymbol(symbol);

        function isClassLikeSymbol(symbol: Symbol) {
            if (!symbol || !symbol.valueDeclaration) {
                return false;
            }

            let targetSymbol: Symbol;
            if (symbol.valueDeclaration.kind === SyntaxKind.FunctionDeclaration) {
                targetSymbol = symbol;
            }
            else if (isDeclarationOfFunctionOrClassExpression(symbol)) {
                targetSymbol = (symbol.valueDeclaration as VariableDeclaration).initializer.symbol;
            }

            // if there is a prototype property assignment like:
            //     foo.prototype.method = function () { }
            // then the symbol for "foo" will have a member
            return targetSymbol && targetSymbol.members && targetSymbol.members.size > 0;
        }
    }

    function getCodeActions(range: TextRange, context: RefactorContext): CodeAction[] {
        const sourceFile = context.boundSourceFile;
        const checker = context.program.getTypeChecker();
        const token = getTokenAtPosition(sourceFile, range.pos);
        const ctorSymbol = checker.getSymbolAtLocation(token);

        if (!(ctorSymbol.flags & (SymbolFlags.Function | SymbolFlags.Variable))) {
            return [];
        }

        const ctorDeclaration = ctorSymbol.valueDeclaration;

        const changeTracker = textChanges.ChangeTracker.fromCodeFixContext(context);
        let newClassDeclaration: ClassDeclaration;
        switch (ctorDeclaration.kind) {
            case SyntaxKind.FunctionDeclaration:
                newClassDeclaration = createClassFromFunctionDeclaration(ctorDeclaration as FunctionDeclaration);
                break;

            case SyntaxKind.VariableDeclaration:
                const initializer = (<VariableDeclaration>ctorDeclaration).initializer;
                if (initializer && initializer.kind === SyntaxKind.FunctionExpression) {
                    ctorName = (<FunctionExpression>initializer).name;
                    ctorBody = (<FunctionExpression>initializer).body;
                    ctorParameterDeclarations = (<FunctionExpression>initializer).parameters;
                }
                break;
        }
        changeTracker.replaceNode(sourceFile, ctorDeclaration, newClassDeclaration);

        return [{
            description: "Test",
            changes: changeTracker.getChanges()
        }];

        function createClassMembersFromSymbol(symbol: Symbol) {
            
        }

        function createClassFromVariableDeclaration(node: VariableDeclaration): ClassDeclaration {
            const initializer = node.initializer;
            if (initializer && initializer.kind === SyntaxKind.FunctionExpression) {
                return createClassDeclaration(/*decorators*/ undefined, /*modifiers*/ undefined, node.name,
                    /*typeParameters*/ undefined, /*heritageClauses*/ undefined, memberElements);
            }
        }

        function createClassFromFunctionDeclaration(node: FunctionDeclaration): ClassDeclaration {
            const newConstructor = createConstructor(/*decorators*/ undefined, /*modifiers*/ undefined, node.parameters, node.body);
            const memberElements: ClassElement[] = [newConstructor];

            // all instance members are stored in the "member" array of ctorSymbol
            if (ctorSymbol.members) {
                ctorSymbol.members.forEach(member => {
                    const memberElement = createClassElementForSymbol(member, /*modifiers*/ undefined);
                    if (memberElement) {
                        memberElements.push(memberElement);
                    }
                });
            }

            // all static members are stored in the "exports" array of ctorSymbol
            if (ctorSymbol.exports) {
                ctorSymbol.exports.forEach(member => {
                    const memberElement = createClassElementForSymbol(member, [createToken(SyntaxKind.StaticKeyword)]);
                    if (memberElement) {
                        memberElements.push(memberElement);
                    }
                });
            }

            return createClassDeclaration(/*decorators*/ undefined, /*modifiers*/ undefined, node.name,
                /*typeParameters*/ undefined, /*heritageClauses*/ undefined, memberElements);
        }

        function createClassElementForSymbol(symbol: Symbol, modifiers: Modifier[]): ClassElement {
            // both property and methods are bound as property symbols
            if (!(symbol.flags & SymbolFlags.Property)) {
                return;
            }

            const memberDeclaration = symbol.valueDeclaration as PropertyAccessExpression;
            const assignmentBinaryExpression = memberDeclaration.parent as BinaryExpression;

            // delete the entire statement if this expression is the sole expression to take care of the semicolon at the end
            if (assignmentBinaryExpression.parent && assignmentBinaryExpression.parent.kind === SyntaxKind.ExpressionStatement) {
                changeTracker.deleteNode(sourceFile, assignmentBinaryExpression.parent);
            }
            else {
                changeTracker.deleteNode(sourceFile, assignmentBinaryExpression);
            }

            if (!assignmentBinaryExpression.right) {
                return createProperty([], modifiers, symbol.name, /*questionToken*/ undefined,
                    /*type*/ undefined, /*initializer*/ undefined);
            }

            switch (assignmentBinaryExpression.right.kind) {
                case SyntaxKind.FunctionExpression:
                    const functionExpression = assignmentBinaryExpression.right as FunctionExpression;
                    return createMethod(/*decorators*/ undefined, modifiers, /*asteriskToken*/ undefined, memberDeclaration.name,
                        /*typeParameters*/ undefined, functionExpression.parameters, /*type*/ undefined, functionExpression.body);
                case SyntaxKind.ArrowFunction:
                    const arrowFunction = assignmentBinaryExpression.right as ArrowFunction;
                    const arrowFunctionBody = arrowFunction.body;
                    let bodyBlock: Block;

                    // case 1: () => { return [1,2,3] }
                    if (arrowFunctionBody.kind === SyntaxKind.Block) {
                        bodyBlock = arrowFunctionBody as Block;
                    }
                    // case 2: () => [1,2,3]
                    else {
                        const expression = arrowFunctionBody as Expression;
                        bodyBlock = createBlock([createReturn(expression)]);
                    }
                    return createMethod(/*decorators*/ undefined, modifiers, /*asteriskToken*/ undefined, memberDeclaration.name,
                        /*typeParameters*/ undefined, arrowFunction.parameters, /*type*/ undefined, bodyBlock);
                default:
                    return createProperty(/*decorators*/ undefined, modifiers, memberDeclaration.name, /*questionToken*/ undefined,
                        /*type*/ undefined, assignmentBinaryExpression.right);
            }
        }
    }
}