/* @internal */
namespace ts {
    export interface Refactor {
        /** Description of the refactor to display in the UI of the editor */
        description: string;

        /** An unique code associated with each refactor */
        refactorCode: number;

        /** A fast syntactic check to see if the refactor is applicable at given position */
        isApplicableAtPosition(sourceFile: SourceFile, start: number, end: number): boolean;

        /** Compute the associated code actions */
        getCodeActions(context: RefactorContext): CodeAction[];

        /** Whether this refactor can be suggested without the editor proactively asking for refactors */
        canBeSuggested: boolean;
    }
    
    export interface RefactorContext {
        refactorCode: number;
        sourceFile: SourceFile;
        span: TextSpan;
        program: Program;
        newLineCharacter: string;
        host: LanguageServiceHost;
        cancellationToken: CancellationToken;
    }

    export namespace refactor {
        // A map with the refactor code as key, the refactor itself as value
        const registeredRefactors: Refactor[] = [];

        export function registerRefactor(refactor: Refactor) {
            registeredRefactors[refactor.refactorCode] = refactor;
        }

        export function getSupportedRefactorCodes() {
            return Object.keys(registeredRefactors);
        }

        export function getApplicableRefactorsAtPosition(sourceFile: SourceFile, start: number, end: number) {
            const results: Refactor[] = [];
            for (const code in registeredRefactors) {
                const refactor = registeredRefactors[code];
                if (refactor.isApplicableAtPosition(sourceFile, start, end)) {
                    results.push(refactor);
                }
            }
            return results;
        }

        export function getCodeActionsOfRefactor(context: RefactorContext): CodeAction[] {
            const refactor = registeredRefactors[context.refactorCode];
            return refactor.getCodeActions(context);
        }
    }
}
