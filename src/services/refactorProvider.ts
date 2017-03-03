/* @internal */
namespace ts {
    export interface Refactor {
        /** Description of the refactor to display in the UI of the editor */
        description: string;

        /** An unique code associated with each refactor */
        refactorCode: number;

        /** A fast syntactic check to see if the refactor is applicable at given position */
        isApplicableForRange(range: TextRange, context: RefactorContext): boolean;
        isApplicableForNode(node: Node, context: RefactorContext): boolean;

        /** Compute the associated code actions */
        getCodeActions(context: RefactorContext): CodeAction[];

        /** Whether this refactor can be suggested without the editor proactively asking for refactors */
        canBeSuggested: boolean;
    }
    
    export interface RefactorContext {
        sourceFile: SourceFile;
        program: Program;
        newLineCharacter: string;
    }

    export namespace refactor {
        // A map with the refactor code as key, the refactor itself as value
        const registeredRefactors: Refactor[] = [];
        let suggestableRefactors: Refactor[];

        export function registerRefactor(refactor: Refactor) {
            registeredRefactors[refactor.refactorCode] = refactor;
        }

        export function getApplicableRefactorsForRange(range: TextRange, context: RefactorContext) {
            const results: Refactor[] = [];
            for (const code in registeredRefactors) {
                const refactor = registeredRefactors[code];
                if (refactor.isApplicableForRange(range, context)) {
                    results.push(refactor);
                }
            }
            return results;
        }

        export function getCodeActionsForRefactor(refactorCode: number, context: RefactorContext): CodeAction[] {
            const refactor = registeredRefactors[refactorCode];
            return refactor.getCodeActions(context);
        }

        export function getSuggestableRefactors() {
            if (!suggestableRefactors) {
                suggestableRefactors = filter(registeredRefactors, r => r.canBeSuggested);
            }
            return suggestableRefactors;
        }
    }
}
