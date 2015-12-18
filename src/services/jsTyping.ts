// Copyright (c) Microsoft. All rights reserved. Licensed under the Apache License, Version 2.0. 
// See LICENSE.txt in the project root for complete license information.

/// <reference path='services.ts' />

/* @internal */
namespace ts.JsTyping {

    interface HostType {
        directoryExists: (path: string) => boolean;
        fileExists: (fileName: string) => boolean;
        readFile: (path: string, encoding?: string) => string;
        readDirectory: (path: string, extension?: string, exclude?: string[], depth?: number) => string[];
        writeFile: (path: string, data: string, writeByteOrderMark?: boolean) => void;
    };

    var _host: HostType;
    var _safeList: Map<string>;

    // a typing name to typing file path mapping
    var inferredTypings: Map<string> = {};

    function tryParseJson(jsonPath: string): any {
        if (_host.fileExists(jsonPath)) {
            try {
                // Strip out single-line comments
                let contents = _host.readFile(jsonPath).replace(/^\/\/(.*)$/gm, "");
                return JSON.parse(contents);
            }
            catch (e) { }
        }
        return undefined;
    }
    
    /**
     * @param cachePath is the path to the cache location, which contains a tsd.json file and a typings folder
     * @param fileNames are the file names that belongs to the same project
     * @param globalCachePath is used 1. to get safe list file path 2. when we can't locate the project root path 
     * @param projectRootPath
     * @param typingOptions
     * @param compilerOptions is used for typing inferring. 
     */
    export function discoverTypings(
        host: HostType,
        fileNames: string[],
        globalCachePath: string,
        cachePath: string,
        typingOptions: TypingOptions,
        compilerOptions?: CompilerOptions)
        : { cachedTypingPaths: string[], newTypingNames: string[], filesToWatch: string[], newTsdJsonPath?: string } {

        _host = host;
        // Clear inferred typings map
        inferredTypings = {};

        // Normalize everything
        globalCachePath = ts.normalizePath(globalCachePath);
        cachePath = cachePath ? ts.normalizePath(cachePath) : globalCachePath;
        fileNames = fileNames.map(ts.normalizePath).filter(f => ts.getBaseFileName(f) !== "lib.d.ts");

        let safeListFilePath = ts.combinePaths(globalCachePath, "safeList.json");
        if (!_safeList && _host.fileExists(safeListFilePath)) {
            _safeList = tryParseJson(safeListFilePath);
        }

        let filesToWatch: string[] = [];
        // Directories to search for package.json, bower.json and other typing information
        let searchDirs: string[] = [];
        let exclude: string[] = [];

        if (typingOptions) {
            mergeTypings(typingOptions.include);
            exclude = typingOptions.exclude ? typingOptions.exclude : [];

            if (typingOptions.enableAutoDiscovery) {
                searchDirs = ts.deduplicate(fileNames.map(ts.getDirectoryPath));
                for (let searchDir of searchDirs) {
                    let packageJsonPath = ts.combinePaths(searchDir, "package.json");
                    getTypingNamesFromJson(packageJsonPath, filesToWatch);

                    let bowerJsonPath = ts.combinePaths(searchDir, "bower.json");
                    getTypingNamesFromJson(bowerJsonPath, filesToWatch);

                    let nodeModulesPath = ts.combinePaths(searchDir, "node_modules");
                    getTypingNamesFromNodeModuleFolder(nodeModulesPath, filesToWatch);
                }

                getTypingNamesFromSourceFileNames(fileNames);
                getTypingNamesFromCompilerOptions(compilerOptions);
            }

            let newTsdJsonPath: string;
            let typingsPath = ts.combinePaths(cachePath, "typings");
            let tsdJsonPath = ts.combinePaths(cachePath, "tsd.json");
            let tsdJsonDict = tryParseJson(tsdJsonPath);
            if (tsdJsonDict) {
                // The "notFound" property in the tsd.json is a list of items that were not found in DefinitelyTyped.
                // Therefore if they don't come with d.ts files we should not retry downloading these packages.
                if (hasProperty(tsdJsonDict, "notFound")) {
                    for (let notFoundTypingName of tsdJsonDict["notFound"]) {
                        if (inferredTypings.hasOwnProperty(notFoundTypingName) && !inferredTypings[notFoundTypingName]) {
                            delete inferredTypings[notFoundTypingName];
                        }
                    }
                }

                // The "installed" property in the tsd.json serves as a registry of installed typings. Each item 
                // of this object has a key of the relative file path, and a value that contains the corresponding
                // commit hash.
                if (hasProperty(tsdJsonDict, "installed")) {
                    for (let cachedTypingPath of Object.keys(tsdJsonDict.installed)) {
                        // Assuming the cachedTypingPath has the format of "[package name]/[file name]"
                        let cachedTypingName = cachedTypingPath.substr(0, cachedTypingPath.indexOf('/'));
                        // If the inferred[cachedTypingName] is already not null, which means we found a corresponding
                        // d.ts file that coming with the package. That one should take higher priority.
                        if (hasProperty(inferredTypings, cachedTypingName) && !inferredTypings[cachedTypingName]) {
                            inferredTypings[cachedTypingName] = ts.combinePaths(typingsPath, cachedTypingPath);
                        }
                    }
                }
            } else if (!host.fileExists(tsdJsonPath)) {
                var tsdJsonOptions = {
                    version: "v4",
                    repo: "DefinitelyTyped/DefinitelyTyped",
                    ref: "master",
                    path: "typings",
                };
                host.writeFile(tsdJsonPath, JSON.stringify(tsdJsonOptions, null, "  "));
                newTsdJsonPath = tsdJsonPath;
            }

            // Remove typings that the user has added to the exclude list
            for (let excludeTypingName of exclude) {
                delete inferredTypings[excludeTypingName];
            }

            let newTypingNames: string[] = [];
            let cachedTypingPaths: string[] = [];
            for (let typing in inferredTypings) {
                if (inferredTypings[typing]) {
                    cachedTypingPaths.push(inferredTypings[typing]);
                }
                else {
                    newTypingNames.push(typing);
                }
            }
            return { cachedTypingPaths, newTypingNames, filesToWatch, newTsdJsonPath };
        }
        else {
            return { cachedTypingPaths: [], newTypingNames: [], filesToWatch: [], newTsdJsonPath: null }
        }
    }

    /**
     * Merge a given list of typingNames to the inferredTypings map
     */
    function mergeTypings(typingNames: string[]) {
        if (!typingNames) {
            return;
        }

        for (let typing of typingNames) {
            if (!inferredTypings.hasOwnProperty(typing)) {
                inferredTypings[typing] = undefined;
            }
        }
    }

    /**
     * Get the typing info from common package manager json files like package.json or bower.json
     */
    function getTypingNamesFromJson(jsonPath: string, filesToWatch: string[]) {
        let jsonDict = tryParseJson(jsonPath);
        if (jsonDict) {
            filesToWatch.push(jsonPath);
            if (jsonDict.hasOwnProperty("dependencies")) {
                mergeTypings(Object.keys(jsonDict.dependencies));
            }
        }
    }

    /**
     * Infer typing names from given file names. For example, the file name "jquery-min.2.3.4.js"
     * should be inferred to the 'jquery' typing name; and "angular-route.1.2.3.js" should be inferred
     * to the 'angular-route' typing name.
     * @param fileNames are the names for source files in the project
     * @param safeList is the list of names that we are confident they are library names that requires typing
     */
    function getTypingNamesFromSourceFileNames(fileNames: string[]) {
        let jsFileNames = fileNames.filter(f => ts.fileExtensionIs(f, ".js"));
        let inferredTypingNames = jsFileNames.map(f => ts.removeFileExtension(ts.getBaseFileName(f.toLowerCase())));
        let cleanedTypingNames = inferredTypingNames.map(f => f.replace(/((?:\.|-)min(?=\.|$))|((?:-|\.)\d+)/g, ""));
        _safeList === undefined ? mergeTypings(cleanedTypingNames) : mergeTypings(cleanedTypingNames.filter(f => _safeList.hasOwnProperty(f)));
    }

    /**
     * Infer typing names from node_module folder
     * @param nodeModulesPath is the path to the "node_modules" folder
     */
    function getTypingNamesFromNodeModuleFolder(nodeModulesPath: string, filesToWatch: string[]) {
        // Todo: add support for ModuleResolutionHost too
        if (!_host.directoryExists(nodeModulesPath)) {
            return;
        }

        let typingNames: string[] = [];
        let packageJsonFiles =
            _host.readDirectory(nodeModulesPath, /*extension*/undefined, /*exclude*/undefined, /*depth*/2).filter(f => ts.getBaseFileName(f) === "package.json");
        for (let packageJsonFile of packageJsonFiles) {
            let packageJsonDict = tryParseJson(packageJsonFile);
            if (!packageJsonDict) { continue; }

            filesToWatch.push(packageJsonFile);

            // npm 3 has the package.json contains a "_requiredBy" field
            // we should include all the top level module names for npm 2, and only module names whose
            // "_requiredBy" field starts with "#" or equals "/" for npm 3.
            if (packageJsonDict._requiredBy &&
                packageJsonDict._requiredBy.filter((r: string) => r[0] === "#" || r === "/").length === 0) {
                continue;
            }
            
            // If the package has its own d.ts typings, those will take over. Otherwise the package name will be used 
            // to download d.ts files from DefinitelyTyped
            let packageName = packageJsonDict["name"];
            if (packageJsonDict.hasOwnProperty("typings")) {
                let absPath = ts.getNormalizedAbsolutePath(packageJsonDict.typings, ts.getDirectoryPath(packageJsonFile));
                inferredTypings[packageName] = absPath;
            }
            else {
                typingNames.push(packageName);
            }
        }
        mergeTypings(typingNames);
    }

    function getTypingNamesFromCompilerOptions(options: CompilerOptions) {
        let typingNames: string[] = [];
        if (!options) {
            return;
        }

        if (options.jsx === JsxEmit.React) {
            typingNames.push("react");
        }
        if (options.moduleResolution === ModuleResolutionKind.NodeJs) {
            typingNames.push("node");
        }
        mergeTypings(typingNames);
    }

    /**
     * Updates the tsd.json cache's "notFound" custom property. This property is used to determine if an attempt has already been
     * made to resolve a particular typing.
     * @param cachedTypingsPaths The list of resolved cached d.ts paths
     * @param newTypings The list of new typings that the host attempted to acquire using TSD
     * @param cachePath The path to the local tsd.json cache
     */
    export function updateTypingsConfig(
        host: HostType, cachedTypingsPaths: string[], newTypingNames: string[], cachePath: string): void {
        let installedTypingsCache: string[];
        let tsdJsonPath = ts.combinePaths(cachePath, "tsd.json");
        let cacheTsdJsonDict = tryParseJson(tsdJsonPath);
        if (cacheTsdJsonDict) {
            let notFound: string[] = [];
            if (cacheTsdJsonDict.hasOwnProperty("installed")) {
                installedTypingsCache = Object.keys(cacheTsdJsonDict.installed);
                notFound = ts.filter(newTypingNames, i => !isInstalled(i, installedTypingsCache));
            }
            if (cacheTsdJsonDict.hasOwnProperty("notFound")) {
                notFound = ts.deduplicate<string>(cacheTsdJsonDict["notFound"].concat(notFound));
            }
            if (notFound.length > 0) {
                cacheTsdJsonDict["notFound"] = notFound;
                host.writeFile(tsdJsonPath, JSON.stringify(cacheTsdJsonDict));
            }
        }
    }

    function isInstalled(typing: string, installedKeys: string[]) {
        for (let key of installedKeys) {
            if (key.indexOf(typing + '/') === 0) {
                return true;
            }
        }
        return false;
    }
}