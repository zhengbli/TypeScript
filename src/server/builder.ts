﻿/// <reference path="..\compiler\commandLineParser.ts" />
/// <reference path="..\services\services.ts" />
/// <reference path="protocol.d.ts" />
/// <reference path="session.ts" />
/// <reference types="node" />

namespace ts.server {

    interface Hash {
        update(data: any, input_encoding?: string): Hash;
        digest(encoding: string): any;
    }

    const crypto: {
        createHash(algorithm: string): Hash
    } = require("crypto");

    /**
     * An abstract file info that maintains a shape signature.
     */
    export class BuilderFileInfo {

        private lastCheckedShapeSignature: string;

        constructor(public readonly scriptInfo: ScriptInfo, public readonly project: Project) {
        }

        public isExternalModule() {
            const sourceFile = this.getSourceFile();
            return isExternalModule(sourceFile) || this.containsOnlyAmbientModules(sourceFile);
        }

        /**
         * For script files that contains only ambient external modules, although they are not external module files,
         * they can only be consumed via importing elements in them. Regular script files cannot consume them. Therefore,
         * there are no point to rebuild all script files if these special files have changed. However, if any statement
         * in the file is not ambient external module, we treat it as a regular script file.
         */
        private containsOnlyAmbientModules(sourceFile: SourceFile) {
            // ambient module declaration will not create externalModuleIndicator
            // and we only consider files containing purely ambient module declarations
            // as external module files
            for (const statement of sourceFile.statements) {
                if (statement.kind !== SyntaxKind.ModuleDeclaration || (<ModuleDeclaration>statement).name.kind !== SyntaxKind.StringLiteral) {
                    return false;
                }
            }
            return true;
        }

        public computeHash(text: string): string {
            return crypto.createHash("md5")
                .update(text)
                .digest("base64");
        }

        public getSourceFile(): SourceFile {
            return this.project.getSourceFile(this.scriptInfo.path);
        }

        /**
         * @return {boolean} indicates if the shape signature has changed since last update.
         */
        public updateShapeSignature() {
            const sourceFile = this.getSourceFile();
            if (!sourceFile) {
                return true;
            }

            const lastSignature = this.lastCheckedShapeSignature;
            if (sourceFile.isDeclarationFile) {
                this.lastCheckedShapeSignature = this.computeHash(sourceFile.text);
            }
            else {
                const emitOutput = this.project.getLanguageService(/*ensureSynchronized*/ true).getEmitOutput(this.scriptInfo.fileName, /*emitOnlyDtsFiles*/ true);
                if (emitOutput.outputFiles && emitOutput.outputFiles.length > 0) {
                    this.lastCheckedShapeSignature = this.computeHash(emitOutput.outputFiles[0].text);
                }
            }
            return !lastSignature || this.lastCheckedShapeSignature !== lastSignature;
        }
    }

    export interface Builder {
        readonly project: Project;
        getFilesAffectedBy(fileName: string): string[];
        onProjectUpdateGraph(): void;
        emitFile(fileName: string, writeFile: (path: string, data: string, writeByteOrderMark?: boolean) => void, forced?: boolean): boolean;
    }

    abstract class AbstractBuilder<T extends BuilderFileInfo> implements Builder {

        private fileInfos = createFileMap<T>();

        constructor(public readonly project: Project) {
        }

        protected getFileInfo(path: Path): T {
            return this.fileInfos.get(path);
        }

        protected getAllFiles(): Path[] {
            return this.fileInfos.getKeys();
        }

        protected setFileInfo(path: Path, info: T) {
            this.fileInfos.set(path, info);
        }

        protected removeFileInfo(path: Path) {
            if (this.fileInfos.contains(path)) {
                this.fileInfos.remove(path);
            }
        }

        protected forEachFileInfo(action: (fileInfo: T) => any) {
            this.fileInfos.forEachValue((path: Path, value: T) => action(value));
        }

        abstract getFilesAffectedBy(fileName: string): string[];
        abstract onProjectUpdateGraph(): void;

        emitFile(fileName: string, writeFile: (path: string, data: string, writeByteOrderMark?: boolean) => void, forced?: boolean): boolean {
            const path = toPath(fileName, getDirectoryPath(fileName), createGetCanonicalFileName(this.project.projectService.host.useCaseSensitiveFileNames));
            const fileInfo = this.getFileInfo(path);
            if (!fileInfo) {
                return false;
            }

            const { emitSkipped, outputFiles } = this.project.getFileEmitOutput(fileInfo.scriptInfo);
            if (!emitSkipped) {
                for (const outputFile of outputFiles) {
                    writeFile(outputFile.name, outputFile.text, outputFile.writeByteOrderMark);
                }
            }
            return !emitSkipped;
        }
    }

    class NonModuleBuilder extends AbstractBuilder<BuilderFileInfo> {

        onProjectUpdateGraph() {
        }

        getOrCreateFileInfo(path: Path) {
            const fileInfo = this.getFileInfo(path);
            if (!fileInfo) {
                const scriptInfo = this.project.getScriptInfo(path);
                this.setFileInfo(path, new BuilderFileInfo(scriptInfo, this.project));
            }
            return fileInfo;
        }

        getFilesAffectedBy(fileName: string): string[] {
            const path = toPath(fileName, getDirectoryPath(fileName), createGetCanonicalFileName(this.project.projectService.to));
            const info = this.getOrCreateFileInfo(path);
            let result: string[];
            if (info.updateShapeSignature()) {
                const options = this.project.getCompilerOptions();
                if (options && (options.out || options.outFile)) {
                    result = [fileName];
                }
                else {
                    result = this.project.getFileNamesWithoutDefaultLib();
                }
            }
            else {
                result = [fileName];
            }
            return result;
        }
    }

    class ModuleBuilderFileInfo extends BuilderFileInfo {
        references: ModuleBuilderFileInfo[] = [];
        referencedBy: ModuleBuilderFileInfo[] = [];
        scriptVersionForReferences: string;

        private finalized = false;

        getReferencedByFileNames() {
            return map(this.referencedBy, info => info.scriptInfo.fileName);
        }

        static compareFileInfos(lf: ModuleBuilderFileInfo, rf: ModuleBuilderFileInfo): number {
            const l = lf.scriptInfo.fileName;
            const r = rf.scriptInfo.fileName;
            return (l < r ? -1 : (l > r ? 1 : 0));
        };

        static addToReferenceList(array: ModuleBuilderFileInfo[], fileInfo: ModuleBuilderFileInfo, afterFinalized: boolean) {
            if (!afterFinalized || array.length === 0) {
                array.push(fileInfo);
            }
            else {
                const insertIndex = binarySearch(array, fileInfo, ModuleBuilderFileInfo.compareFileInfos);
                if (insertIndex < 0) {
                    array.splice(~insertIndex, 0, fileInfo);
                }
            }
        }

        static removeFromReferenceList(array: ModuleBuilderFileInfo[], fileInfo: ModuleBuilderFileInfo, afterFinalized?: boolean) {
            if (!array) {
                return;
            }

            if (!afterFinalized) {
                // Before finalized the reference lists are not sorted
                for (let i = 0; i < array.length; i++) {
                    if (ModuleBuilderFileInfo.compareFileInfos(array[i], fileInfo) === 0) {
                        array.splice(i, 1);
                        break;
                    }
                }
            }
            else {
                const removeIndex = binarySearch(array, fileInfo, ModuleBuilderFileInfo.compareFileInfos);
                if (removeIndex >= 0) {
                    array.splice(removeIndex, 1);
                }
            }
        }

        addReferencedBy(fileInfo: ModuleBuilderFileInfo): void {
            ModuleBuilderFileInfo.addToReferenceList(this.referencedBy, fileInfo, this.finalized);
        }

        removeReferencedBy(fileInfo: ModuleBuilderFileInfo): void {
            ModuleBuilderFileInfo.removeFromReferenceList(this.referencedBy, fileInfo, this.finalized);
        }

        finalize() {
            if (this.finalized) {
                return;
            }

            if (this.references.length > 0) {
                this.references.sort(ModuleBuilderFileInfo.compareFileInfos);
            }
            if (this.referencedBy.length > 0) {
                this.referencedBy.sort(ModuleBuilderFileInfo.compareFileInfos);
            }
            this.finalized = true;
        }
    }

    class ModuleBuilder extends AbstractBuilder<ModuleBuilderFileInfo> {

        private isDependencyGraphBuilt = false;
        private lastUpdateProjectVersion: string;

        private getReferencedFileInfos(path: Path): ModuleBuilderFileInfo[] {
            const referencedFilePaths = this.project.getReferencedFiles(path);
            if (referencedFilePaths && referencedFilePaths.length > 0) {
                return map(referencedFilePaths, f => this.getFileInfo(f)).sort(ModuleBuilderFileInfo.compareFileInfos);
            }
            return [];
        }

        private ensureDependencyGraph() {
            if (this.isDependencyGraphBuilt) {
                return;
            }

            const scriptInfos = this.project.getScriptInfos();
            for (const scriptInfo of scriptInfos) {
                const newFileInfo = new ModuleBuilderFileInfo(scriptInfo, this.project);
                this.setFileInfo(scriptInfo.path, newFileInfo);
                this.updateFileReferences(newFileInfo);
            }
            this.forEachFileInfo(fileInfo => fileInfo.finalize());
            this.isDependencyGraphBuilt = true;
        }

        onProjectUpdateGraph() {
            this.updateProjectDependencyGraph();
        }

        private updateProjectDependencyGraph() {
            this.ensureDependencyGraph();

            if (!this.lastUpdateProjectVersion || this.project.getProjectVersion() !== this.lastUpdateProjectVersion) {
                const currentScriptInfos = this.project.getScriptInfos();
                for (const scriptInfo of currentScriptInfos) {
                    const fileInfo = this.getFileInfo(scriptInfo.path);
                    if (fileInfo) {
                        this.updateFileReferences(fileInfo);
                    }
                    else {
                        const newFileInfo = new ModuleBuilderFileInfo(scriptInfo, this.project);
                        this.setFileInfo(scriptInfo.path, newFileInfo);
                        this.updateFileReferences(newFileInfo);
                    }
                }
                this.forEachFileInfo(fileInfo => {
                    const sourceFile = this.project.getSourceFile(fileInfo.scriptInfo.path);
                    if (!sourceFile) {
                        // This file was deleted from this project
                        this.removeFileReferences(fileInfo);
                        this.removeFileInfo(fileInfo.scriptInfo.path);
                    }
                });
                this.lastUpdateProjectVersion = this.project.getProjectVersion();
            }
            return;
        }

        private updateFileReferences(fileInfo: ModuleBuilderFileInfo) {
            // Only need to update if the content of the file changed.
            if (fileInfo.scriptVersionForReferences === fileInfo.scriptInfo.getLatestVersion() ||
                !fileInfo.isExternalModule()) {
                return;
            }

            const newReferences = this.getReferencedFileInfos(fileInfo.scriptInfo.path);
            const oldReferences = fileInfo.references;

            let oldIndex = 0;
            let newIndex = 0;
            while (oldIndex < oldReferences.length && newIndex < newReferences.length) {
                const oldReference = oldReferences[oldIndex];
                const newReference = newReferences[newIndex];
                const compare = ModuleBuilderFileInfo.compareFileInfos(oldReference, newReference);
                if (compare < 0) {
                    // New reference is greater then current reference. That means
                    // the current reference doesn't exist anymore after parsing. So delete
                    // references.
                    oldReference.removeReferencedBy(fileInfo);
                    oldIndex++;
                }
                else if (compare > 0) {
                    // A new reference info. Add it.
                    newReference.addReferencedBy(fileInfo);
                    newIndex++;
                }
                else {
                    // Equal. Go to next
                    oldIndex++;
                    newIndex++;
                }
            }
            // Clean old references
            for (let i = oldIndex; i < oldReferences.length; i++) {
                oldReferences[i].removeReferencedBy(fileInfo);
            }
            // Update new references
            for (let i = newIndex; i < newReferences.length; i++) {
                newReferences[i].addReferencedBy(fileInfo);
            }

            fileInfo.references = newReferences;
            fileInfo.scriptVersionForReferences = fileInfo.scriptInfo.getLatestVersion();
        }

        private removeFileReferences(fileInfo: ModuleBuilderFileInfo) {
            for (const reference of fileInfo.references) {
                reference.removeReferencedBy(fileInfo);
            }
            fileInfo.references = [];
        }

        getFilesAffectedBy(fileName: string): string[] {
            this.ensureDependencyGraph();

            const path = toPath(fileName, getDirectoryPath(fileName), createGetCanonicalFileName(this.project.projectService.host.useCaseSensitiveFileNames));
            const fileInfo = this.getFileInfo(path);
            if(fileInfo && fileInfo.updateShapeSignature()) {
                let result: string[];
                if (!fileInfo.isExternalModule()) {
                    result = this.project.getFileNamesWithoutDefaultLib();
                }
                else {
                    const options = this.project.getCompilerOptions();
                    if (options && (options.isolatedModules || options.out || options.outFile)) {
                        result = [fileName];
                    }
                    else {
                        result = fileInfo.getReferencedByFileNames();
                        // Needs to count the trigger file itself because it for sure has changed.
                        result.push(fileName);
                    }
                }
                return result;
            }
            return [fileName];
        }
    }

    export function createBuilder(project: Project): Builder {
        if (project.projectKind === ProjectKind.Configured) {
            const moduleKind = project.getCompilerOptions().module;
            switch (moduleKind) {
                case ModuleKind.None:
                    return new NonModuleBuilder(project);
                default:
                    return new ModuleBuilder(project);
            }
        }
        return new NonModuleBuilder(project);
    }
}