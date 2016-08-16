/// <reference path="..\compiler\commandLineParser.ts" />
/// <reference path="..\services\services.ts" />
/// <reference path="protocol.d.ts" />
/// <reference path="utilities.ts" />
/// <reference path="session.ts" />
/// <reference path="scriptVersionCache.ts"/>
/// <reference path="lsHost.ts"/>
/// <reference path="project.ts"/>

namespace ts.server {
    export const maxProgramSizeForNonTsFiles = 20 * 1024 * 1024;

    /**
     * This helper function processes a list of projects and return the concatenated, sortd and deduplicated output of processing each project.
     */
    export function combineProjectOutput<T>(projects: Project[], action: (project: Project) => T[], comparer?: (a: T, b: T) => number, areEqual?: (a: T, b: T) => boolean) {
        const result = projects.reduce<T[]>((previous, current) => concatenate(previous, action(current)), []).sort(comparer);
        return projects.length > 1 ? deduplicate(result, areEqual) : result;
    }

    export interface ProjectServiceEventHandler {
        (eventName: string, project: Project, fileName: NormalizedPath): void;
    }

    export interface HostConfiguration {
        formatCodeOptions: FormatCodeSettings;
        hostInfo: string;
    }

    interface ConfigFileConversionResult {
        success: boolean;
        errors?: Diagnostic[];

        projectOptions?: ProjectOptions;
    }

    interface OpenConfigFileResult {
        success: boolean;
        errors?: Diagnostic[];

        project?: ConfiguredProject;
    }

    interface OpenConfiguredProjectResult {
        configFileName?: string;
        configFileErrors?: Diagnostic[];
    }

    interface FilePropertyReader<T> {
        getFileName(f: T): string;
        getScriptKind(f: T): ScriptKind;
        hasMixedContent(f: T): boolean;
    }

    const fileNamePropertyReader: FilePropertyReader<string> = {
        getFileName: x => x,
        getScriptKind: _ => undefined,
        hasMixedContent: _ => false
    };

    const externalFilePropertyReader: FilePropertyReader<protocol.ExternalFile> = {
        getFileName: x => x.fileName,
        getScriptKind: x => x.scriptKind,
        hasMixedContent: x => x.hasMixedContent
    };

    function findProjectByName<T extends Project>(projectName: string, projects: T[]): T {
        for (const proj of projects) {
            if (proj.getProjectName() === projectName) {
                return proj;
            }
        }
    }

    /**
     * TODO: enforce invariants:
     *  - script info can be never migrate to state - root file in inferred project, this is only a starting point
     *  - if script info has more that one containing projects - it is not a root file in inferred project because:
     *    - references in inferred project supercede the root part
     *    - root/reference in non-inferred project beats root in inferred project
     */
    function isRootFileInInferredProject(info: ScriptInfo): boolean {
        if (info.containingProjects.length === 0) {
            return false;
        }
        return info.containingProjects[0].projectKind === ProjectKind.Inferred && info.containingProjects[0].isRoot(info);
    }

    class DirectoryWatchers {
        /**
         * a path to directory watcher map that detects added tsconfig files
         **/
        private readonly directoryWatchersForTsconfig: Map<FileWatcher> = {};
        /**
         * count of how many projects are using the directory watcher.
         * If the number becomes 0 for a watcher, then we should close it.
         **/
        private readonly directoryWatchersRefCount: Map<number> = {};

        constructor(private readonly projectService: ProjectService) {
        }

        stopWatchingDirectory(directory: string) {
            // if the ref count for this directory watcher drops to 0, it's time to close it
            this.directoryWatchersRefCount[directory]--;
            if (this.directoryWatchersRefCount[directory] === 0) {
                this.projectService.logger.info(`Close directory watcher for: ${directory}`);
                this.directoryWatchersForTsconfig[directory].close();
                delete this.directoryWatchersForTsconfig[directory];
            }
        }

        startWatchingContainingDirectoriesForFile(fileName: string, project: InferredProject, callback: (fileName: string) => void) {
            let currentPath = getDirectoryPath(fileName);
            let parentPath = getDirectoryPath(currentPath);
            while (currentPath != parentPath) {
                if (!this.directoryWatchersForTsconfig[currentPath]) {
                    this.projectService.logger.info(`Add watcher for: ${currentPath}`);
                    this.directoryWatchersForTsconfig[currentPath] = this.projectService.host.watchDirectory(currentPath, callback);
                    this.directoryWatchersRefCount[currentPath] = 1;
                }
                else {
                    this.directoryWatchersRefCount[currentPath] += 1;
                }
                project.directoriesWatchedForTsconfig.push(currentPath);
                currentPath = parentPath;
                parentPath = getDirectoryPath(parentPath);
            }
        }
    }

    export class ProjectService {
        private readonly documentRegistry: DocumentRegistry;

        /**
         * Container of all known scripts
         */
        private readonly filenameToScriptInfo = createFileMap<ScriptInfo>();
        /**
         * maps external project file name to list of config files that were the part of this project
         */
        private readonly externalProjectToConfiguredProjectMap: Map<NormalizedPath[]> = {};

        /**
         * external projects (configuration and list of root files is not controlled by tsserver)
         */
        readonly externalProjects: ExternalProject[] = [];
        /**
         * projects built from openFileRoots
         **/
        readonly inferredProjects: InferredProject[] = [];
        /**
         * projects specified by a tsconfig.json file
         **/
        readonly configuredProjects: ConfiguredProject[] = [];
        /**
         * list of open files
         */
        readonly openFiles: ScriptInfo[] = [];

        private compilerOptionsForInferredProjects: CompilerOptions;
        private readonly directoryWatchers: DirectoryWatchers;
        private readonly throttledOperations: ThrottledOperations;

        private readonly hostConfiguration: HostConfiguration;

        private changedFiles: ScriptInfo[];

        toCanonicalFileName: (f: string) => string;

        constructor(public readonly host: ServerHost,
            public readonly logger: Logger,
            public readonly cancellationToken: HostCancellationToken,
            private readonly useSingleInferredProject: boolean,
            private readonly eventHandler?: ProjectServiceEventHandler) {

            this.toCanonicalFileName = createGetCanonicalFileName(host.useCaseSensitiveFileNames);
            this.directoryWatchers = new DirectoryWatchers(this);
            this.throttledOperations = new ThrottledOperations(host);
            // ts.disableIncrementalParsing = true;

            this.hostConfiguration = {
                formatCodeOptions: getDefaultFormatCodeSettings(this.host),
                hostInfo: "Unknown host"
            };

            this.documentRegistry = createDocumentRegistry(host.useCaseSensitiveFileNames, host.getCurrentDirectory());
        }

        getChangedFiles_TestOnly() {
            return this.changedFiles;
        }

        ensureInferredProjectsUpToDate_TestOnly() {
            this.ensureInferredProjectsUpToDate();
        }

        setCompilerOptionsForInferredProjects(compilerOptions: CompilerOptions): void {
            this.compilerOptionsForInferredProjects = compilerOptions;
            for (const proj of this.inferredProjects) {
                proj.setCompilerOptions(compilerOptions);
            }
            this.updateProjectGraphs(this.inferredProjects);
        }

        stopWatchingDirectory(directory: string) {
            this.directoryWatchers.stopWatchingDirectory(directory);
        }

        findProject(projectName: string): Project {
            if (projectName === undefined) {
                return undefined;
            }
            if (isInferredProjectName(projectName)) {
                this.ensureInferredProjectsUpToDate();
                return findProjectByName(projectName, this.inferredProjects);
            }
            return this.findExternalProjectByProjectName(projectName) || this.findConfiguredProjectByProjectName(toNormalizedPath(projectName));
        }

        getDefaultProjectForFile(fileName: NormalizedPath, refreshInferredProjects: boolean) {
            if (refreshInferredProjects) {
                this.ensureInferredProjectsUpToDate();
            }
            const scriptInfo = this.getScriptInfoForNormalizedPath(fileName);
            return scriptInfo && scriptInfo.getDefaultProject();
        }

        private ensureInferredProjectsUpToDate() {
            if (this.changedFiles) {
                let projectsToUpdate: Project[];
                if (this.changedFiles.length === 1) {
                    // simpliest case - no allocations
                    projectsToUpdate = this.changedFiles[0].containingProjects;
                }
                else {
                    projectsToUpdate = [];
                    for (const f of this.changedFiles) {
                         projectsToUpdate = projectsToUpdate.concat(f.containingProjects);
                    }
                }
                this.updateProjectGraphs(projectsToUpdate);
                this.changedFiles = undefined;
            }
        }

        private findContainingExternalProject(fileName: NormalizedPath): ExternalProject {
            for (const proj of this.externalProjects) {
                if (proj.containsFile(fileName)) {
                    return proj;
                }
            }
            return undefined;
        }

        getFormatCodeOptions(file?: NormalizedPath) {
            if (file) {
                const info = this.getScriptInfoForNormalizedPath(file);
                if (info) {
                    return info.formatCodeSettings;
                }
            }
            return this.hostConfiguration.formatCodeOptions;
        }

        private updateProjectGraphs(projects: Project[]) {
            let shouldRefreshInferredProjects = false;
            for (const p of projects) {
                if (!p.updateGraph()) {
                    shouldRefreshInferredProjects = true;
                }
            }
            if (shouldRefreshInferredProjects) {
                this.refreshInferredProjects();
            }
        }

        private onSourceFileChanged(fileName: NormalizedPath) {
            const info = this.getScriptInfoForNormalizedPath(fileName);
            if (!info) {
                this.logger.info(`Error: got watch notification for unknown file: ${fileName}`);
            }

            if (!this.host.fileExists(fileName)) {
                // File was deleted
                this.handleDeletedFile(info);
            }
            else {
                if (info && (!info.isOpen)) {
                    // file has been changed which might affect the set of referenced files in projects that include 
                    // this file and set of inferred projects
                    info.reloadFromFile();
                    this.updateProjectGraphs(info.containingProjects);
                }
            }
        }

        private handleDeletedFile(info: ScriptInfo) {
            this.logger.info(`${info.fileName} deleted`);

            info.stopWatcher();

            // TODO: handle isOpen = true case

            if (!info.isOpen) {
                this.filenameToScriptInfo.remove(info.path);

                // capture list of projects since detachAllProjects will wipe out original list 
                const containingProjects = info.containingProjects.slice();
                info.detachAllProjects();

                // update projects to make sure that set of referenced files is correct
                this.updateProjectGraphs(containingProjects);

                if (!this.eventHandler) {
                    return;
                }

                for (const openFile of this.openFiles) {
                    this.eventHandler("context", openFile.getDefaultProject(), openFile.fileName);
                }
            }

            this.printProjects();
        }

        /**
         * This is the callback function when a watched directory has added or removed source code files.
         * @param project the project that associates with this directory watcher
         * @param fileName the absolute file name that changed in watched directory
         */
        private onSourceFileInDirectoryChangedForConfiguredProject(project: ConfiguredProject, fileName: string) {
            // If a change was made inside "folder/file", node will trigger the callback twice:
            // one with the fileName being "folder/file", and the other one with "folder".
            // We don't respond to the second one.
            if (fileName && !ts.isSupportedSourceFileName(fileName, project.getCompilerOptions())) {
                return;
            }

            this.logger.info(`Detected source file changes: ${fileName}`);
            this.throttledOperations.schedule(
                project.configFileName,
                /*delay*/250,
                () => this.handleChangeInSourceFileForConfiguredProject(project));
        }

        private handleChangeInSourceFileForConfiguredProject(project: ConfiguredProject) {
            const { projectOptions } = this.convertConfigFileContentToProjectOptions(project.configFileName);

            const newRootFiles = projectOptions.files.map((f => this.getCanonicalFileName(f)));
            const currentRootFiles = project.getRootFiles().map((f => this.getCanonicalFileName(f)));

            // We check if the project file list has changed. If so, we update the project.
            if (!arrayIsEqualTo(currentRootFiles.sort(), newRootFiles.sort())) {
                // For configured projects, the change is made outside the tsconfig file, and
                // it is not likely to affect the project for other files opened by the client. We can
                // just update the current project.
                this.updateConfiguredProject(project);

                // Call refreshInferredProjects to clean up inferred projects we may have
                // created for the new files
                this.refreshInferredProjects();
            }
        }

        private onConfigChangedForConfiguredProject(project: ConfiguredProject) {
            this.logger.info(`Config file changed: ${project.configFileName}`);
            this.updateConfiguredProject(project);
            this.refreshInferredProjects();
        }

        /**
         * This is the callback function when a watched directory has an added tsconfig file.
         */
        private onConfigFileAddedForInferredProject(fileName: string) {
            // TODO: check directory separators
            if (getBaseFileName(fileName) != "tsconfig.json") {
                this.logger.info(`${fileName} is not tsconfig.json`);
                return;
            }

            this.logger.info(`Detected newly added tsconfig file: ${fileName}`);
            this.reloadProjects();
        }

        private getCanonicalFileName(fileName: string) {
            const name = this.host.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase();
            return normalizePath(name);
        }

        private removeProject(project: Project) {
            this.logger.info(`remove project: ${project.getRootFiles().toString()}`);

            project.close();

            switch (project.projectKind) {
                case ProjectKind.External:
                    removeItemFromSet(this.externalProjects, <ExternalProject>project);
                    break;
                case ProjectKind.Configured:
                    removeItemFromSet(this.configuredProjects, <ConfiguredProject>project);
                    break;
                case ProjectKind.Inferred:
                    removeItemFromSet(this.inferredProjects, <InferredProject>project);
                    break;
            }
        }

        private assignScriptInfoToInferredProjectIfNecessary(info: ScriptInfo, addToListOfOpenFiles: boolean): void {
            const externalProject = this.findContainingExternalProject(info.fileName);
            if (externalProject) {
                // file is already included in some external project - do nothing
                if (addToListOfOpenFiles) {
                    this.openFiles.push(info);
                }
                return;
            }

            let foundConfiguredProject = false;
            for (const p of info.containingProjects) {
                // file is the part of configured project
                if (p.projectKind === ProjectKind.Configured) {
                    foundConfiguredProject = true;
                    if (addToListOfOpenFiles) {
                        ((<ConfiguredProject>p)).addOpenRef();
                    }
                }
            }
            if (foundConfiguredProject) {
                if (addToListOfOpenFiles) {
                    this.openFiles.push(info);
                }
                return;
            }

            if (info.containingProjects.length === 0) {
                // create new inferred project p with the newly opened file as root
                // or add root to existing inferred project if 'useOneInferredProject' is true
                const inferredProject = this.createInferredProjectWithRootFileIfNecessary(info);
                if (!this.useSingleInferredProject) {
                    // if useOneInferredProject is not set then try to fixup ownership of open files
                    // check 'defaultProject !== inferredProject' is necessary to handle cases 
                    // when creation inferred project for some file has added other open files into this project (i.e. as referenced files)
                    // we definitely don't want to delete the project that was just created
                    for (const f of this.openFiles) {
                        if (f.containingProjects.length === 0) {
                            // this is orphaned file that we have not processed yet - skip it
                            continue;
                        }
                        const defaultProject = f.getDefaultProject();
                        if (isRootFileInInferredProject(info) && defaultProject !== inferredProject && inferredProject.containsScriptInfo(f)) {
                            // open file used to be root in inferred project, 
                            // this inferred project is different from the one we've just created for current file
                            // and new inferred project references this open file.
                            // We should delete old inferred project and attach open file to the new one
                            this.removeProject(defaultProject);
                            f.attachToProject(inferredProject);
                        }
                    }
                }
            }

            if (addToListOfOpenFiles) {
                this.openFiles.push(info);
            }
        }

        /**
          * Remove this file from the set of open, non-configured files.
          * @param info The file that has been closed or newly configured
          */
        private closeOpenFile(info: ScriptInfo): void {
            // Closing file should trigger re-reading the file content from disk. This is
            // because the user may chose to discard the buffer content before saving
            // to the disk, and the server's version of the file can be out of sync.
            info.reloadFromFile();

            removeItemFromSet(this.openFiles, info);
            info.isOpen = false;

            // collect all projects that should be removed
            let projectsToRemove: Project[];
            for (const p of info.containingProjects) {
                if (p.projectKind === ProjectKind.Configured) {
                    // last open file in configured project - close it
                    if ((<ConfiguredProject>p).deleteOpenRef() === 0) {
                        (projectsToRemove || (projectsToRemove = [])).push(p);
                    }
                }
                else if (p.projectKind === ProjectKind.Inferred && p.isRoot(info)) {
                    // open file in inferred project
                    (projectsToRemove || (projectsToRemove = [])).push(p);
                }
            }
            if (projectsToRemove) {
                for (const project of projectsToRemove) {
                    this.removeProject(project);
                }

                let orphanFiles: ScriptInfo[];
                // for all open files
                for (const f of this.openFiles) {
                    // collect orphanted files and try to re-add them as newly opened
                    if (f.containingProjects.length === 0) {
                        (orphanFiles || (orphanFiles = [])).push(f);
                    }
                }

                // treat orphaned files as newly opened
                if (orphanFiles) {
                    for (const f of orphanFiles) {
                        this.assignScriptInfoToInferredProjectIfNecessary(f, /*addToListOfOpenFiles*/ false);
                    }
                }
            }
            if (info.containingProjects.length === 0) {
                // if there are not projects that include this script info - delete it
                this.filenameToScriptInfo.remove(info.path);
            }
        }

        /**
         * This function tries to search for a tsconfig.json for the given file. If we found it,
         * we first detect if there is already a configured project created for it: if so, we re-read
         * the tsconfig file content and update the project; otherwise we create a new one.
         */
        private openOrUpdateConfiguredProjectForFile(fileName: NormalizedPath): OpenConfiguredProjectResult {
            const searchPath = getDirectoryPath(fileName);
            this.logger.info(`Search path: ${searchPath}`);

            // check if this file is already included in one of external projects
            const configFileName = this.findConfigFile(asNormalizedPath(searchPath));
            if (!configFileName) {
                this.logger.info("No config files found.");
                return {};
            }

            this.logger.info(`Config file name: ${configFileName}`);

            const project = this.findConfiguredProjectByProjectName(configFileName);
            if (!project) {
                const { success, errors } = this.openConfigFile(configFileName, fileName);
                if (!success) {
                    return { configFileName, configFileErrors: errors };
                }

                // even if opening config file was successful, it could still
                // contain errors that were tolerated.
                this.logger.info(`Opened configuration file ${configFileName}`);
                if (errors && errors.length > 0) {
                    return { configFileName, configFileErrors: errors };
                }
            }
            else {
                this.updateConfiguredProject(project);
            }

            return { configFileName };
        }

        // This is different from the method the compiler uses because
        // the compiler can assume it will always start searching in the
        // current directory (the directory in which tsc was invoked).
        // The server must start searching from the directory containing
        // the newly opened file.
        private findConfigFile(searchPath: NormalizedPath): NormalizedPath {
            while (true) {
                const tsconfigFileName = asNormalizedPath(combinePaths(searchPath, "tsconfig.json"));
                if (this.host.fileExists(tsconfigFileName)) {
                    return tsconfigFileName;
                }

                const jsconfigFileName = asNormalizedPath(combinePaths(searchPath, "jsconfig.json"));
                if (this.host.fileExists(jsconfigFileName)) {
                    return jsconfigFileName;
                }

                const parentPath = asNormalizedPath(getDirectoryPath(searchPath));
                if (parentPath === searchPath) {
                    break;
                }
                searchPath = parentPath;
            }
            return undefined;
        }

        private printProjects() {
            if (!this.logger.hasLevel(LogLevel.verbose)) {
                return;
            }

            this.logger.startGroup();

            let counter = 0;
            counter = printProjects(this.logger, this.externalProjects, counter);
            counter = printProjects(this.logger, this.configuredProjects, counter);
            counter = printProjects(this.logger, this.inferredProjects, counter);

            this.logger.info("Open files: ");
            for (const rootFile of this.openFiles) {
                this.logger.info(rootFile.fileName);
            }

            this.logger.endGroup();

            function printProjects(logger: Logger, projects: Project[], counter: number) {
                for (const project of projects) {
                    project.updateGraph();
                    logger.info(`Project '${project.getProjectName()}' (${ProjectKind[project.projectKind]}) ${counter}`);
                    logger.info(project.filesToString());
                    logger.info("-----------------------------------------------");
                    counter++;
                }
                return counter;
            }
        }

        private findConfiguredProjectByProjectName(configFileName: NormalizedPath) {
            return findProjectByName(configFileName, this.configuredProjects);
        }

        private findExternalProjectByProjectName(projectFileName: string) {
            return findProjectByName(projectFileName, this.externalProjects);
        }

        private convertConfigFileContentToProjectOptions(configFilename: string): ConfigFileConversionResult {
            configFilename = normalizePath(configFilename);

            const configObj = parseConfigFileTextToJson(configFilename, this.host.readFile(configFilename));
            if (configObj.error) {
                return { success: false, errors: [configObj.error] };
            }

            const parsedCommandLine = parseJsonConfigFileContent(
                configObj.config,
                this.host,
                getDirectoryPath(configFilename),
                /*existingOptions*/ {},
                configFilename);

            Debug.assert(!!parsedCommandLine.fileNames);

            if (parsedCommandLine.errors && (parsedCommandLine.errors.length > 0)) {
                return { success: false, errors: parsedCommandLine.errors };
            }

            if (parsedCommandLine.fileNames.length === 0) {
                const error = createCompilerDiagnostic(Diagnostics.The_config_file_0_found_doesn_t_contain_any_source_files, configFilename);
                return { success: false, errors: [error] };
            }

            const projectOptions: ProjectOptions = {
                files: parsedCommandLine.fileNames,
                compilerOptions: parsedCommandLine.options,
                configHasFilesProperty: configObj.config["files"] !== undefined,
                wildcardDirectories: parsedCommandLine.wildcardDirectories,
                compileOnSave: parsedCommandLine.compileOnSave
            };
            return { success: true, projectOptions };
        }

        private exceededTotalSizeLimitForNonTsFiles<T>(options: CompilerOptions, fileNames: T[], propertyReader: FilePropertyReader<T>) {
            if (options && options.disableSizeLimit || !this.host.getFileSize) {
                return false;
            }
            let totalNonTsFileSize = 0;
            for (const f of fileNames) {
                const fileName = propertyReader.getFileName(f);
                if (hasTypeScriptFileExtension(fileName)) {
                    continue;
                }
                totalNonTsFileSize += this.host.getFileSize(fileName);
                if (totalNonTsFileSize > maxProgramSizeForNonTsFiles) {
                    return true;
                }
            }
            return false;
        }

        private createAndAddExternalProject(projectFileName: string, files: protocol.ExternalFile[], options: protocol.ExternalProjectCompilerOptions) {
            const project = new ExternalProject(
                projectFileName,
                this,
                this.documentRegistry,
                options,
                /*languageServiceEnabled*/ !this.exceededTotalSizeLimitForNonTsFiles(options, files, externalFilePropertyReader),
                !!options.compileOnSave);

            const errors = this.addFilesToProjectAndUpdateGraph(project, files, externalFilePropertyReader, /*clientFileName*/ undefined);
            this.externalProjects.push(project);
            return { project, errors };
        }

        private createAndAddConfiguredProject(configFileName: NormalizedPath, projectOptions: ProjectOptions, clientFileName?: string) {
            const sizeLimitExceeded = this.exceededTotalSizeLimitForNonTsFiles(projectOptions.compilerOptions, projectOptions.files, fileNamePropertyReader);
            const project = new ConfiguredProject(
                configFileName,
                this,
                this.documentRegistry,
                projectOptions.configHasFilesProperty,
                projectOptions.compilerOptions,
                projectOptions.wildcardDirectories,
                /*languageServiceEnabled*/ !sizeLimitExceeded,
                /*compileOnSaveEnabled*/ !!projectOptions.compileOnSave);

            const errors = this.addFilesToProjectAndUpdateGraph(project, projectOptions.files, fileNamePropertyReader, clientFileName);

            project.watchConfigFile(project => this.onConfigChangedForConfiguredProject(project));
            if (!sizeLimitExceeded) {
                this.watchConfigDirectoryForProject(project, projectOptions);
            }
            project.watchWildcards((project, path) => this.onSourceFileInDirectoryChangedForConfiguredProject(project, path));

            this.configuredProjects.push(project);
            return { project, errors };
        }

        private watchConfigDirectoryForProject(project: ConfiguredProject, options: ProjectOptions): void {
            if (!options.configHasFilesProperty) {
                project.watchConfigDirectory((project, path) => this.onSourceFileInDirectoryChangedForConfiguredProject(project, path));
            }
        }

        private addFilesToProjectAndUpdateGraph<T>(project: ConfiguredProject | ExternalProject, files: T[], propertyReader: FilePropertyReader<T>, clientFileName: string): Diagnostic[] {
            let errors: Diagnostic[];
            for (const f of files) {
                const rootFilename = propertyReader.getFileName(f);
                const scriptKind = propertyReader.getScriptKind(f);
                const hasMixedContent = propertyReader.hasMixedContent(f);
                if (this.host.fileExists(rootFilename)) {
                    const info = this.getOrCreateScriptInfoForNormalizedPath(toNormalizedPath(rootFilename), /*openedByClient*/ clientFileName == rootFilename, /*fileContent*/ undefined, scriptKind, hasMixedContent);
                    project.addRoot(info);
                }
                else {
                    (errors || (errors = [])).push(createCompilerDiagnostic(Diagnostics.File_0_not_found, rootFilename));
                }
            }
            project.updateGraph();
            return errors;
        }

        private openConfigFile(configFileName: NormalizedPath, clientFileName?: string): OpenConfigFileResult {
            const conversionResult = this.convertConfigFileContentToProjectOptions(configFileName);
            if (!conversionResult.success) {
                return { success: false, errors: conversionResult.errors };
            }
            const { project, errors } = this.createAndAddConfiguredProject(configFileName, conversionResult.projectOptions, clientFileName);
            return { success: true, project, errors };
        }

        private updateNonInferredProject<T>(project: ExternalProject | ConfiguredProject, newUncheckedFiles: T[], propertyReader: FilePropertyReader<T>, newOptions: CompilerOptions, compileOnSave: boolean) {
            const oldRootScriptInfos = project.getRootScriptInfos();
            const newRootScriptInfos: ScriptInfo[] = [];
            const newRootScriptInfoMap: NormalizedPathMap<ScriptInfo> = createNormalizedPathMap<ScriptInfo>();

            let rootFilesChanged = false;
            for (const f of newUncheckedFiles) {
                const newRootFile = propertyReader.getFileName(f);
                if (!this.host.fileExists(newRootFile)) {
                    continue;
                }
                const normalizedPath = toNormalizedPath(newRootFile);
                let scriptInfo = this.getScriptInfoForNormalizedPath(normalizedPath);
                if (!scriptInfo || !project.isRoot(scriptInfo)) {
                    rootFilesChanged = true;
                    if (!scriptInfo) {
                        const scriptKind = propertyReader.getScriptKind(f);
                        const hasMixedContent = propertyReader.hasMixedContent(f);
                        scriptInfo = this.getOrCreateScriptInfoForNormalizedPath(normalizedPath, /*openedByClient*/ false, /*fileContent*/ undefined, scriptKind, hasMixedContent);
                    }
                }
                newRootScriptInfos.push(scriptInfo);
                newRootScriptInfoMap.set(scriptInfo.fileName, scriptInfo);
            }

            if (rootFilesChanged || newRootScriptInfos.length !== oldRootScriptInfos.length) {
                let toAdd: ScriptInfo[];
                let toRemove: ScriptInfo[];
                for (const oldFile of oldRootScriptInfos) {
                    if (!newRootScriptInfoMap.contains(oldFile.fileName)) {
                        (toRemove || (toRemove = [])).push(oldFile);
                    }
                }
                for (const newFile of newRootScriptInfos) {
                    if (!project.isRoot(newFile)) {
                        (toAdd || (toAdd = [])).push(newFile);
                    }
                }
                if (toRemove) {
                    for (const f of toRemove) {
                        project.removeFile(f);
                    }
                }
                if (toAdd) {
                    for (const f of toAdd) {
                        if (f.isOpen && isRootFileInInferredProject(f)) {
                            // if file is already root in some inferred project 
                            // - remove the file from that project and delete the project if necessary
                            const inferredProject = f.containingProjects[0];
                            inferredProject.removeFile(f);
                            if (!inferredProject.hasRoots()) {
                                this.removeProject(inferredProject);
                            }
                        }
                        project.addRoot(f);
                    }
                }
            }

            project.setCompilerOptions(newOptions);
            project.compileOnSaveEnabled = !!compileOnSave;
            project.updateGraph();
        }

        private updateConfiguredProject(project: ConfiguredProject) {
            if (!this.host.fileExists(project.configFileName)) {
                this.logger.info("Config file deleted");
                this.removeProject(project);
                return;
            }

            const { success, projectOptions, errors } = this.convertConfigFileContentToProjectOptions(project.configFileName);
            if (!success) {
                return errors;
            }

            if (this.exceededTotalSizeLimitForNonTsFiles(projectOptions.compilerOptions, projectOptions.files, fileNamePropertyReader)) {
                project.setCompilerOptions(projectOptions.compilerOptions);
                if (!project.languageServiceEnabled) {
                    // language service is already disabled
                    return;
                }
                project.disableLanguageService();
                project.stopWatchingDirectory();
            }
            else {
                if (!project.languageServiceEnabled) {
                    project.enableLanguageService();
                }
                this.watchConfigDirectoryForProject(project, projectOptions);
                this.updateNonInferredProject(project, projectOptions.files, fileNamePropertyReader, projectOptions.compilerOptions, projectOptions.compileOnSave);
            }
        }

        createInferredProjectWithRootFileIfNecessary(root: ScriptInfo) {
            const useExistingProject = this.useSingleInferredProject && this.inferredProjects.length;
            const project = useExistingProject
                ? this.inferredProjects[0]
                : new InferredProject(this, this.documentRegistry, /*languageServiceEnabled*/ true, this.compilerOptionsForInferredProjects);

            project.addRoot(root);

            this.directoryWatchers.startWatchingContainingDirectoriesForFile(
                root.fileName,
                project,
                fileName => this.onConfigFileAddedForInferredProject(fileName));

            project.updateGraph();

            if (!useExistingProject) {
                this.inferredProjects.push(project);
            }
            return project;
        }

        /**
         * @param uncheckedFileName is absolute pathname
         * @param fileContent is a known version of the file content that is more up to date than the one on disk
         */

        getOrCreateScriptInfo(uncheckedFileName: string, openedByClient: boolean, fileContent?: string, scriptKind?: ScriptKind) {
            return this.getOrCreateScriptInfoForNormalizedPath(toNormalizedPath(uncheckedFileName), openedByClient, fileContent, scriptKind);
        }

        getScriptInfo(uncheckedFileName: string) {
            return this.getScriptInfoForNormalizedPath(toNormalizedPath(uncheckedFileName));
        }

        getOrCreateScriptInfoForNormalizedPath(fileName: NormalizedPath, openedByClient: boolean, fileContent?: string, scriptKind?: ScriptKind, hasMixedContent?: boolean) {
            let info = this.getScriptInfoForNormalizedPath(fileName);
            if (!info) {
                let content: string;
                if (this.host.fileExists(fileName)) {
                    // by default pick whatever content was supplied as the argument
                    // if argument was not given - then for mixed content files assume that its content is empty string
                    content = fileContent || (hasMixedContent ? "" : this.host.readFile(fileName));
                }
                if (!content) {
                    if (openedByClient) {
                        content = "";
                    }
                }
                if (content !== undefined) {
                    info = new ScriptInfo(this.host, fileName, content, scriptKind, openedByClient, hasMixedContent);
                    info.setFormatOptions(toEditorSettings(this.getFormatCodeOptions()));
                    // do not watch files with mixed content - server doesn't know how to interpret it
                    this.filenameToScriptInfo.set(info.path, info);
                    if (!info.isOpen && !hasMixedContent) {
                        info.setWatcher(this.host.watchFile(fileName, _ => this.onSourceFileChanged(fileName)));
                    }
                }
            }
            if (info) {
                if (fileContent) {
                    info.reload(fileContent);
                }
                if (openedByClient) {
                    info.isOpen = true;
                }
            }
            return info;
        }

        getScriptInfoForNormalizedPath(fileName: NormalizedPath) {
            return this.filenameToScriptInfo.get(normalizedPathToPath(fileName, this.host.getCurrentDirectory(), this.toCanonicalFileName));
        }

        setHostConfiguration(args: protocol.ConfigureRequestArguments) {
            if (args.file) {
                const info = this.getScriptInfoForNormalizedPath(toNormalizedPath(args.file));
                if (info) {
                    info.setFormatOptions(args.formatOptions);
                    this.logger.info(`Host configuration update for file ${args.file}`);
                }
            }
            else {
                if (args.hostInfo !== undefined) {
                    this.hostConfiguration.hostInfo = args.hostInfo;
                    this.logger.info(`Host information ${args.hostInfo}`);
                }
                if (args.formatOptions) {
                    mergeMaps(this.hostConfiguration.formatCodeOptions, args.formatOptions);
                    this.logger.info("Format host information updated");
                }
            }
        }

        closeLog() {
            this.logger.close();
        }

        /**
         * This function rebuilds the project for every file opened by the client
         */
        reloadProjects() {
            this.logger.info("reload projects.");
            // try to reload config file for all open files
            for (const info of this.openFiles) {
                this.openOrUpdateConfiguredProjectForFile(info.fileName);
            }
            this.refreshInferredProjects();
        }

        /**
         * This function is to update the project structure for every projects.
         * It is called on the premise that all the configured projects are
         * up to date.
         */
        refreshInferredProjects() {
            this.logger.info("updating project structure from ...");
            this.printProjects();

            const orphantedFiles: ScriptInfo[] = [];
            // collect all orphanted script infos from open files
            for (const info of this.openFiles) {
                if (info.containingProjects.length === 0) {
                    orphantedFiles.push(info);
                }
                else {
                    if (isRootFileInInferredProject(info) && info.containingProjects.length > 1) {
                        const inferredProject = info.containingProjects[0];
                        Debug.assert(inferredProject.projectKind === ProjectKind.Inferred);
                        inferredProject.removeFile(info);
                        if (!inferredProject.hasRoots()) {
                            this.removeProject(inferredProject);
                        }
                    }
                }
            }
            for (const f of orphantedFiles) {
                this.assignScriptInfoToInferredProjectIfNecessary(f, /*addToListOfOpenFiles*/ false);
            }

            for (const p of this.inferredProjects) {
                p.updateGraph();
            }
            this.printProjects();
        }

        /**
         * Open file whose contents is managed by the client
         * @param filename is absolute pathname
         * @param fileContent is a known version of the file content that is more up to date than the one on disk
         */
        openClientFile(fileName: string, fileContent?: string, scriptKind?: ScriptKind): OpenConfiguredProjectResult {
            return this.openClientFileWithNormalizedPath(toNormalizedPath(fileName), fileContent, scriptKind);
        }

        openClientFileWithNormalizedPath(fileName: NormalizedPath, fileContent?: string, scriptKind?: ScriptKind, hasMixedContent?: boolean): OpenConfiguredProjectResult {
            const { configFileName = undefined, configFileErrors = undefined }: OpenConfiguredProjectResult = this.findContainingExternalProject(fileName)
                ? {}
                : this.openOrUpdateConfiguredProjectForFile(fileName);

            // at this point if file is the part of some configured/external project then this project should be created
            const info = this.getOrCreateScriptInfoForNormalizedPath(fileName, /*openedByClient*/ true, fileContent, scriptKind, hasMixedContent);
            this.assignScriptInfoToInferredProjectIfNecessary(info, /*addToListOfOpenFiles*/ true);
            this.printProjects();
            return { configFileName, configFileErrors };
        }

        /**
         * Close file whose contents is managed by the client
         * @param filename is absolute pathname
         */
        closeClientFile(uncheckedFileName: string) {
            const info = this.getScriptInfoForNormalizedPath(toNormalizedPath(uncheckedFileName));
            if (info) {
                this.closeOpenFile(info);
                info.isOpen = false;
            }
            this.printProjects();
        }

        private collectChanges(lastKnownProjectVersions: protocol.ProjectVersionInfo[], currentProjects: Project[], result: protocol.ProjectFiles[]): void {
            for (const proj of currentProjects) {
                const knownProject = forEach(lastKnownProjectVersions, p => p.projectName === proj.getProjectName() && p);
                result.push(proj.getChangesSinceVersion(knownProject && knownProject.version));
            }
        }

        synchronizeProjectList(knownProjects: protocol.ProjectVersionInfo[]): protocol.ProjectFiles[] {
            const files: protocol.ProjectFiles[] = [];
            this.collectChanges(knownProjects, this.externalProjects, files);
            this.collectChanges(knownProjects, this.configuredProjects, files);
            this.collectChanges(knownProjects, this.inferredProjects, files);
            return files;
        }

        applyChangesInOpenFiles(openFiles: protocol.ExternalFile[], changedFiles: protocol.ChangedOpenFile[], closedFiles: string[]): void {
            const recordChangedFiles = changedFiles && !openFiles && !closedFiles;
            if (openFiles) {
                for (const file of openFiles) {
                    const scriptInfo = this.getScriptInfo(file.fileName);
                    Debug.assert(!scriptInfo || !scriptInfo.isOpen);
                    const normalizedPath = scriptInfo ? scriptInfo.fileName : toNormalizedPath(file.fileName);
                    this.openClientFileWithNormalizedPath(normalizedPath, file.content, file.scriptKind, file.hasMixedContent);
                }
            }

            if (changedFiles) {
                for (const file of changedFiles) {
                    const scriptInfo = this.getScriptInfo(file.fileName);
                    Debug.assert(!!scriptInfo);
                    // apply changes in reverse order 
                    for (let i = file.changes.length - 1; i >= 0; i--) {
                        const change = file.changes[i];
                        scriptInfo.editContent(change.span.start, change.span.start + change.span.length, change.newText);
                    }
                    if (recordChangedFiles) {
                        if (!this.changedFiles) {
                            this.changedFiles = [scriptInfo];
                        }
                        else if (this.changedFiles.indexOf(scriptInfo) < 0) {
                            this.changedFiles.push(scriptInfo);
                        }
                    }
                }
            }

            if (closedFiles) {
                for (const file of closedFiles) {
                    this.closeClientFile(file);
                }
            }
            // if files were open or closed then explicitly refresh list of inferred projects
            // otherwise if there were only changes in files - record changed files in `changedFiles` and defer the update
            if (openFiles || closedFiles) {
                this.refreshInferredProjects();
            }
        }

        closeExternalProject(uncheckedFileName: string): void {
            const fileName = toNormalizedPath(uncheckedFileName);
            const configFiles = this.externalProjectToConfiguredProjectMap[fileName];
            if (configFiles) {
                let shouldRefreshInferredProjects = false;
                for (const configFile of configFiles) {
                    const configuredProject = this.findConfiguredProjectByProjectName(configFile);
                    if (configuredProject && configuredProject.deleteOpenRef() === 0) {
                        this.removeProject(configuredProject);
                        shouldRefreshInferredProjects = true;
                    }
                }
                if (shouldRefreshInferredProjects) {
                    this.refreshInferredProjects();
                }
            }
            else {
                // close external project
                const externalProject = this.findExternalProjectByProjectName(uncheckedFileName);
                if (externalProject) {
                    this.removeProject(externalProject);
                    this.refreshInferredProjects();
                }
            }
        }

        openExternalProject(proj: protocol.ExternalProject): void {
            const externalProject = this.findExternalProjectByProjectName(proj.projectFileName);
            if (externalProject) {
                this.updateNonInferredProject(externalProject, proj.rootFiles, externalFilePropertyReader, proj.options, proj.options.compileOnSave);
                return;
            }

            let tsConfigFiles: NormalizedPath[];
            const rootFiles: protocol.ExternalFile[] = [];
            for (const file of proj.rootFiles) {
                const normalized = toNormalizedPath(file.fileName);
                if (getBaseFileName(normalized) === "tsconfig.json") {
                    (tsConfigFiles || (tsConfigFiles = [])).push(normalized);
                }
                else {
                    rootFiles.push(file);
                }
            }
            if (tsConfigFiles) {
                // store the list of tsconfig files that belong to the external project
                this.externalProjectToConfiguredProjectMap[proj.projectFileName] = tsConfigFiles;
                for (const tsconfigFile of tsConfigFiles) {
                    let project = this.findConfiguredProjectByProjectName(tsconfigFile);
                    if (!project) {
                        const result = this.openConfigFile(tsconfigFile);
                        // TODO: save errors
                        project = result.success && result.project;
                    }
                    if (project) {
                        // keep project alive even if no documents are opened - its lifetime is bound to the lifetime of containing external project
                        project.addOpenRef();
                    }
                }
            }
            else {
                this.createAndAddExternalProject(proj.projectFileName, rootFiles, proj.options);
            }
        }
    }
}
