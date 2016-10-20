/// <reference types="node" />

namespace ts.server {

    interface Hash {
        update(data: any, input_encoding?: string): Hash;
        digest(encoding: string): any;
    }

    const crypto: {
        createHash(algorithm: string): Hash
    } = require("crypto");

    export interface BuilderHost {
        getReferencedFiles(path: Path): Path[];
        getSourceFile(path: Path): SourceFile;
        getCompilerOptions(): CompilerOptions;
        getProgram(): Program;
        getFilePaths(): Path[];
        getFileVersion(path: Path): string;
        checkFileHaveMixedContent(path: Path): boolean;
        getVersion(): string;
        getProjectRootPath(): string;
        getCanonicalFileName(fileName: string): string;

        getFileEmitOutput?(fileName: string, emitOnlyDtsFiles: boolean): EmitOutput;
        getAllEmittableFiles?(): string[];
        //getScriptInfo?(path: Path): ScriptInfo;
    }

    export function shouldEmitFile(info: BuilderFileInfo) {
        return !info.hasMixedContent;
    }

    export class BuilderFileInfo {

        public readonly path: Path;
        public readonly hasMixedContent: boolean;

        private lastCheckedShapeSignature: string;

        references: BuilderFileInfo[] = [];
        referencedBy: BuilderFileInfo[] = [];
        scriptVersionForReferences: string;

        constructor(public readonly fileName: string, public readonly host: BuilderHost) {
            this.path = toPath(fileName, getDirectoryPath(fileName), host.getCanonicalFileName);

            if (this.host.checkFileHaveMixedContent) {
                this.hasMixedContent = this.host.checkFileHaveMixedContent(this.path);
            }
            else {
                this.hasMixedContent = false;
            }
        }

        static compareFileInfos(lf: BuilderFileInfo, rf: BuilderFileInfo): number {
            const l = lf.fileName;
            const r = rf.fileName;
            return (l < r ? -1 : (l > r ? 1 : 0));
        };

        static addToReferenceList(array: BuilderFileInfo[], fileInfo: BuilderFileInfo) {
            if (array.length === 0) {
                array.push(fileInfo);
                return;
            }

            const insertIndex = binarySearch(array, fileInfo, BuilderFileInfo.compareFileInfos);
            if (insertIndex < 0) {
                array.splice(~insertIndex, 0, fileInfo);
            }
        }

        static removeFromReferenceList(array: BuilderFileInfo[], fileInfo: BuilderFileInfo) {
            if (!array || array.length === 0) {
                return;
            }

            if (array[0] === fileInfo) {
                array.splice(0, 1);
                return;
            }

            const removeIndex = binarySearch(array, fileInfo, BuilderFileInfo.compareFileInfos);
            if (removeIndex >= 0) {
                array.splice(removeIndex, 1);
            }
        }

        addReferencedBy(fileInfo: BuilderFileInfo): void {
            BuilderFileInfo.addToReferenceList(this.referencedBy, fileInfo);
        }

        removeReferencedBy(fileInfo: BuilderFileInfo): void {
            BuilderFileInfo.removeFromReferenceList(this.referencedBy, fileInfo);
        }

        removeFileReferences() {
            for (const reference of this.references) {
                reference.removeReferencedBy(this);
            }
            this.references = [];
        }

        getLatestVersion() {
            if (this.host.getFileVersion) {
                return this.host.getFileVersion(this.path);
            }
            // Otherwise invalidate the file version cache.
            return undefined;
        }

        public isExternalModuleOrHasOnlyAmbientExternalModules() {
            const sourceFile = this.getSourceFile();
            return isExternalModule(sourceFile) || this.containsOnlyAmbientModules(sourceFile);
        }

        /**
         * For script files that contains only ambient external modules, although they are not actually external module files,
         * they can only be consumed via importing elements from them. Regular script files cannot consume them. Therefore,
         * there are no point to rebuild all script files if these special files have changed. However, if any statement
         * in the file is not ambient external module, we treat it as a regular script file.
         */
        private containsOnlyAmbientModules(sourceFile: SourceFile) {
            for (const statement of sourceFile.statements) {
                if (statement.kind !== SyntaxKind.ModuleDeclaration || (<ModuleDeclaration>statement).name.kind !== SyntaxKind.StringLiteral) {
                    return false;
                }
            }
            return true;
        }

        private computeHash(text: string): string {
            return crypto.createHash("md5")
                .update(text)
                .digest("base64");
        }

        private getSourceFile(): SourceFile {
            return this.host.getSourceFile(this.path);
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
                const emitOutput = this.host.getFileEmitOutput(this.fileName, /*emitOnlyDtsFiles*/ true);
                if (emitOutput.outputFiles && emitOutput.outputFiles.length > 0) {
                    this.lastCheckedShapeSignature = this.computeHash(emitOutput.outputFiles[0].text);
                }
            }
            return !lastSignature || this.lastCheckedShapeSignature !== lastSignature;
        }
    }

    export abstract class Builder {

        private fileInfos = createFileMap<BuilderFileInfo>();

        constructor(public readonly host: BuilderHost) {
        }

        protected getFileInfo(path: Path): BuilderFileInfo {
            return this.fileInfos.get(path);
        }

        protected getOrCreateFileInfo(fileName: string): BuilderFileInfo {
            const path = toPath(fileName, getDirectoryPath(fileName), this.host.getCanonicalFileName);
            let fileInfo = this.getFileInfo(path);
            if (!fileInfo) {
                fileInfo = new BuilderFileInfo(fileName, this.host);
                this.setFileInfo(path, fileInfo);
            }
            return fileInfo;
        }

        protected getFileInfoPaths(): Path[] {
            return this.fileInfos.getKeys();
        }

        protected setFileInfo(path: Path, info: BuilderFileInfo) {
            this.fileInfos.set(path, info);
        }

        protected removeFileInfo(path: Path) {
            this.fileInfos.remove(path);
        }

        protected forEachFileInfo(action: (fileInfo: BuilderFileInfo) => any) {
            this.fileInfos.forEachValue((_path, value) => action(value));
        }

        abstract getFileNamesAffectedBy(path: Path): string[];
        abstract updateReferenceGraph(): void;

        /**
         * @returns {boolean} whether the emit was conducted or not
         */
        emitFile(scriptInfo: ScriptInfo, writeFile: (path: string, data: string, writeByteOrderMark?: boolean) => void): boolean {
            const fileInfo = this.getFileInfo(scriptInfo.path);
            if (!fileInfo) {
                return false;
            }

            const { emitSkipped, outputFiles } = this.host.getFileEmitOutput(fileInfo.path, /*emitOnlyDtsFiles*/ false);
            if (!emitSkipped) {
                const projectRootPath = this.host.getProjectRootPath();
                for (const outputFile of outputFiles) {
                    const outputFileAbsoluteFileName = getNormalizedAbsolutePath(outputFile.name, projectRootPath ? projectRootPath : getDirectoryPath(scriptInfo.fileName));
                    writeFile(outputFileAbsoluteFileName, outputFile.text, outputFile.writeByteOrderMark);
                }
            }
            return !emitSkipped;
        }
    }

    class NullBuilder extends Builder {
        getFileNamesAffectedBy(path: Path): string[] {
            return [path, "test"];
        }

        updateReferenceGraph() {
        }
    }

    class NonModuleBuilder extends Builder {

        constructor(public readonly host: BuilderHost) {
            super(host);
        }

        updateReferenceGraph() {
        }

        /**
         * Note: didn't use path as parameter because the returned file names will be directly
         * consumed by the API user, which will use it to interact with file systems. Path
         * should only be used internally, because the case sensitivity is not trustable.
         */
        getFileNamesAffectedBy(path: Path): string[] {
            const info = this.getOrCreateFileInfo(path);
            const singleFileResult = info.hasMixedContent ? [] : [info.fileName];
            if (info.updateShapeSignature()) {
                const options = this.host.getCompilerOptions();
                // If `--out` or `--outFile` is specified, any new emit will result in re-emitting the entire project,
                // so returning the file itself is good enough.
                if (options && (options.out || options.outFile)) {
                    return singleFileResult;
                }
                return this.host.getAllEmittableFiles();
            }
            return singleFileResult;
        }
    }

    class ModuleBuilder extends Builder {

        constructor(public readonly host: BuilderHost) {
            super(host);
        }

        private projectVersionForDependencyGraph: string;

        private getReferencedFileInfos(fileInfo: BuilderFileInfo): BuilderFileInfo[] {
            if (!fileInfo.isExternalModuleOrHasOnlyAmbientExternalModules()) {
                return [];
            }

            const referencedFilePaths = this.host.getReferencedFiles(fileInfo.path);
            if (referencedFilePaths.length > 0) {
                return map(referencedFilePaths, f => this.getOrCreateFileInfo(f)).sort(BuilderFileInfo.compareFileInfos);
            }
            return [];
        }

        updateReferenceGraph() {
            this.ensureProjectDependencyGraphUpToDate();
        }

        private ensureProjectDependencyGraphUpToDate() {
            if (!this.projectVersionForDependencyGraph || this.host.getVersion() !== this.projectVersionForDependencyGraph) {
                const filePaths = this.host.getFilePaths();
                for (const filePath of filePaths) {
                    const fileInfo = this.getOrCreateFileInfo(filePath);
                    this.updateFileReferences(fileInfo);
                }
                this.forEachFileInfo(fileInfo => {
                    if (!this.host.getProgram().getSourceFileByPath(fileInfo.path)) {
                        // This file was deleted from this project
                        fileInfo.removeFileReferences();
                        this.removeFileInfo(fileInfo.path);
                    }
                });
                this.projectVersionForDependencyGraph = this.host.getVersion();
            }
        }

        private updateFileReferences(fileInfo: BuilderFileInfo) {
            // Only need to update if the content of the file changed.
            if (fileInfo.scriptVersionForReferences && fileInfo.scriptVersionForReferences === fileInfo.getLatestVersion()) {
                return;
            }

            const newReferences = this.getReferencedFileInfos(fileInfo);
            const oldReferences = fileInfo.references;

            let oldIndex = 0;
            let newIndex = 0;
            while (oldIndex < oldReferences.length && newIndex < newReferences.length) {
                const oldReference = oldReferences[oldIndex];
                const newReference = newReferences[newIndex];
                const compare = BuilderFileInfo.compareFileInfos(oldReference, newReference);
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
            fileInfo.scriptVersionForReferences = fileInfo.getLatestVersion();
        }

        getFileNamesAffectedBy(path: Path): string[] {
            this.ensureProjectDependencyGraphUpToDate();

            const fileInfo = this.getFileInfo(path);
            const singleFileResult = fileInfo.hasMixedContent ? [] : [fileInfo.fileName];
            
            if (!fileInfo || !fileInfo.updateShapeSignature()) {
                return singleFileResult;
            }

            if (!fileInfo.isExternalModuleOrHasOnlyAmbientExternalModules()) {
                return this.host.getAllEmittableFiles();
            }

            const options = this.host.getCompilerOptions();
            if (options && (options.isolatedModules || options.out || options.outFile)) {
                return singleFileResult;
            }

            // Now we need to if each file in the referencedBy list has a shape change as well.
            // Because if so, its own referencedBy files need to be saved as well to make the
            // emitting result consistent with files on disk.

            // Use slice to clone the array to avoid manipulating in place
            const queue = fileInfo.referencedBy.slice(0);
            const fileNameSet = createMap<BuilderFileInfo>();
            fileNameSet[fileInfo.fileName] = fileInfo;
            while (queue.length > 0) {
                const processingFileInfo = queue.pop();
                if (processingFileInfo.updateShapeSignature() && processingFileInfo.referencedBy.length > 0) {
                    for (const potentialFileInfo of processingFileInfo.referencedBy) {
                        if (!fileNameSet[potentialFileInfo.fileName]) {
                            queue.push(potentialFileInfo);
                        }
                    }
                }
                fileNameSet[processingFileInfo.fileName] = processingFileInfo;
            }
            const result: string[] = [];
            for (const fileName in fileNameSet) {
                if (shouldEmitFile(fileNameSet[fileName])) {
                    result.push(fileName);
                }
            }
            return result;
        }
    }

    export function createBuilder(host: BuilderHost): Builder {
        const options = host.getCompilerOptions();
        if (!options) {
            return new NullBuilder(host);
        }

        const moduleKind = options.module;
        switch (moduleKind) {
            case ModuleKind.None:
                return new NonModuleBuilder(host);
            default:
                return new ModuleBuilder(host);
        }
    }
}