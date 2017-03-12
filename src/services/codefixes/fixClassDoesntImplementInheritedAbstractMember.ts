/* @internal */
namespace ts.codefix {
    registerCodeFix({
        errorCodes: [Diagnostics.Non_abstract_class_0_does_not_implement_inherited_abstract_member_1_from_class_2.code],
        getCodeActions: getActionForClassLikeMissingAbstractMember
    });

    registerCodeFix({
        errorCodes: [Diagnostics.Non_abstract_class_expression_does_not_implement_inherited_abstract_member_0_from_class_1.code],
        getCodeActions: getActionForClassLikeMissingAbstractMember
    });

    function getActionForClassLikeMissingAbstractMember(context: CodeFixContext): CodeAction[] | undefined {
        const sourceFile = context.sourceFile;
        const start = context.span.start;
        // This is the identifier in the case of a class declaration
        // or the class keyword token in the case of a class expression.
        const token = getTokenAtPosition(sourceFile, start);
        const checker = context.program.getTypeChecker();

        if (isClassLike(token.parent)) {
            const classDecl = token.parent as ClassLikeDeclaration;
            const startPos = classDecl.members.pos;

            const extendsNode = getClassExtendsHeritageClauseElement(classDecl);
            const instantiatedExtendsType = checker.getTypeAtLocation(extendsNode);

            // Note that this is ultimately derived from a map indexed by symbol names,
            // so duplicates cannot occur.
            const extendsSymbols = checker.getPropertiesOfType(instantiatedExtendsType);
            const abstractAndNonPrivateExtendsSymbols = extendsSymbols.filter(symbolPointsToNonPrivateAndAbstractMember);

            const insertion = getMissingMembersInsertion(classDecl, abstractAndNonPrivateExtendsSymbols, checker, context.newLineCharacter);

            if (insertion.length) {
                return [{
                    description: getLocaleSpecificMessage(Diagnostics.Implement_inherited_abstract_class),
                    changes: [{
                        fileName: sourceFile.fileName,
                        textChanges: [{
                            span: { start: startPos, length: 0 },
                            newText: insertion
                        }]
                    }]
                }];
            }
        }

        return undefined;

    }

    function symbolPointsToNonPrivateAndAbstractMember(symbol: Symbol): boolean {
        const decls = symbol.getDeclarations();
        Debug.assert(!!(decls && decls.length > 0));
        const flags = getModifierFlags(decls[0]);
        return !(flags & ModifierFlags.Private) && !!(flags & ModifierFlags.Abstract);
    }
}