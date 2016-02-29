﻿// Copyright (c) Microsoft. All rights reserved. Licensed under the Apache License, Version 2.0.
// See LICENSE.txt in the project root for complete license information.

/// <reference path='services.ts' />

/* @internal */
namespace ts.JsTyping {

    interface TypingResolutionHost {
        directoryExists: (path: string) => boolean;
        fileExists: (fileName: string) => boolean;
        readFile: (path: string, encoding?: string) => string;
        readDirectory: (path: string, extension?: string, exclude?: string[], depth?: number) => string[];
    };

    // A map of loose file names to library names
    // that we are confident require typings
    let safeList: Map<string>;
    const notFoundTypingNames: Map<string> = {};

    function isTypingEnabled(options: TypingOptions) {
        if (options) {
            if (options.enableAutoDiscovery || 
                options.include && options.include.length > 0) {
                return true;
            }
        }
        return false;
    }

    /**
     * @param host is the object providing I/O related operations.
     * @param fileNames are the file names that belong to the same project.
     * @param globalCachePath is used to get the safe list file path and as cache path if the project root path isn't specified.
     * @param projectRootPath is the path to the project root directory. This is used for the local typings cache.
     * @param typingOptions are used for customizing the typing inference process.
     * @param compilerOptions are used as a source of typing inference.
     */
    export function discoverTypings(
        host: TypingResolutionHost,
        fileNames: string[],
        globalCachePath: Path,
        projectRootPath: Path,
        typingOptions: TypingOptions,
        compilerOptions: CompilerOptions):
        { cachedTypingPaths: string[], newTypingNames: string[], filesToWatch: string[] } {

        // A typing name to typing file path mapping
        const inferredTypings: Map<string> = {};

        if (!isTypingEnabled(typingOptions)) {
            return { cachedTypingPaths: [], newTypingNames: [], filesToWatch: [] };
        }

        const cachePath = projectRootPath || globalCachePath;
        // Only infer typings for .js and .jsx files
        fileNames = filter(map(fileNames, normalizePath), f => scriptKindIs(f, /*LanguageServiceHost*/ undefined, ScriptKind.JS, ScriptKind.JSX));

        const safeListFilePath = combinePaths(globalCachePath, "safeList.json");
        if (!safeList && host.fileExists(safeListFilePath)) {
            const { config, error } = readConfigFile(safeListFilePath, host.readFile);
            if (!error) {
                safeList = config;
            }
        }

        const filesToWatch: string[] = [];
        // Directories to search for package.json, bower.json and other typing information
        let searchDirs: string[] = [];
        let exclude: string[] = [];

        mergeTypings(typingOptions.include);
        exclude = typingOptions.exclude || [];

        if (typingOptions.enableAutoDiscovery) {
            const possibleSearchDirs = map(fileNames, getDirectoryPath);
            if (projectRootPath !== undefined) {
                possibleSearchDirs.push(projectRootPath);
            }
            searchDirs = deduplicate(possibleSearchDirs);
            for (const searchDir of searchDirs) {
                const packageJsonPath = combinePaths(searchDir, "package.json");
                getTypingNamesFromJson(packageJsonPath, filesToWatch);

                const bowerJsonPath = combinePaths(searchDir, "bower.json");
                getTypingNamesFromJson(bowerJsonPath, filesToWatch);

                const nodeModulesPath = combinePaths(searchDir, "node_modules");
                getTypingNamesFromNodeModuleFolder(nodeModulesPath, filesToWatch);
            }

            getTypingNamesFromSourceFileNames(fileNames);
            getTypingNamesFromCompilerOptions(compilerOptions);
        }

        const typingsPath = combinePaths(cachePath, "typings");
        const tsdJsonPath = combinePaths(cachePath, "tsd.json");
        const { config: tsdJsonDictionary, error } = readConfigFile(tsdJsonPath, host.readFile);
        if (!error) {
            for (const notFoundTypingName in notFoundTypingNames) {
                if (hasProperty(inferredTypings, notFoundTypingName) && !inferredTypings[notFoundTypingName]) {
                    delete inferredTypings[notFoundTypingName];
                }
            }

            // The "installed" property in the tsd.json serves as a registry of installed typings. Each item
            // of this object has a key of the relative file path, and a value that contains the corresponding
            // commit hash.
            if (hasProperty(tsdJsonDictionary, "installed")) {
                for (const cachedTypingPath in tsdJsonDictionary.installed) {
                    // Assuming the cachedTypingPath has the format of "[package name]/[file name]"
                    const cachedTypingName = cachedTypingPath.substr(0, cachedTypingPath.indexOf("/"));
                    // If the inferred[cachedTypingName] is already not null, which means we found a corresponding
                    // d.ts file that coming with the package. That one should take higher priority.
                    if (hasProperty(inferredTypings, cachedTypingName) && !inferredTypings[cachedTypingName]) {
                        inferredTypings[cachedTypingName] = combinePaths(typingsPath, cachedTypingPath);
                    }
                }
            }
        }

        // Remove typings that the user has added to the exclude list
        for (const excludeTypingName of exclude) {
            delete inferredTypings[excludeTypingName];
        }

        const newTypingNames: string[] = [];
        const cachedTypingPaths: string[] = [];
        for (const typing in inferredTypings) {
            if (inferredTypings[typing] !== undefined) {
                cachedTypingPaths.push(inferredTypings[typing]);
            }
            else {
                newTypingNames.push(typing);
            }
        }
        return { cachedTypingPaths, newTypingNames, filesToWatch };

        /**
         * Merge a given list of typingNames to the inferredTypings map
         */
        function mergeTypings(typingNames: string[]) {
            if (!typingNames) {
                return;
            }

            for (const typing of typingNames) {
                if (!hasProperty(inferredTypings, typing)) {
                    inferredTypings[typing] = undefined;
                }
            }
        }

        /**
         * Get the typing info from common package manager json files like package.json or bower.json
         */
        function getTypingNamesFromJson(jsonPath: string, filesToWatch: string[]) {
            const { config, error } = readConfigFile(jsonPath, host.readFile);
            if (!error) {
                filesToWatch.push(jsonPath);
                if (hasProperty(config, "dependencies")) {
                    mergeTypings(getKeys(config.dependencies));
                }
                if (hasProperty(config, "devDependencies")) {
                    mergeTypings(getKeys(config.devDependencies));
                }
                if (hasProperty(config, "optionalDependencies")) {
                    mergeTypings(getKeys(config.optionalDependencies));
                }
                if (hasProperty(config, "peerDependencies")) {
                    mergeTypings(getKeys(config.peerDependencies));
                }
            }
        }

        /**
         * Infer typing names from given file names. For example, the file name "jquery-min.2.3.4.js"
         * should be inferred to the 'jquery' typing name; and "angular-route.1.2.3.js" should be inferred
         * to the 'angular-route' typing name.
         * @param fileNames are the names for source files in the project
         */
        function getTypingNamesFromSourceFileNames(fileNames: string[]) {
            const jsFileNames = filter(fileNames, hasJavaScriptFileExtension);
            const inferredTypingNames = map(jsFileNames, f => removeFileExtension(getBaseFileName(f.toLowerCase())));
            const cleanedTypingNames = map(inferredTypingNames, f => f.replace(/((?:\.|-)min(?=\.|$))|((?:-|\.)\d+)/g, ""));
            if (safeList === undefined) {
                mergeTypings(cleanedTypingNames);
            }
            else {
                mergeTypings(filter(cleanedTypingNames, f => hasProperty(safeList, f)));
            }

            const hasJsxFile = forEach(fileNames, f => scriptKindIs(f, /*LanguageServiceHost*/ undefined, ScriptKind.JSX));
            if (hasJsxFile) {
                mergeTypings(["react"]);
            }
        }

        /**
         * Infer typing names from node_module folder
         * @param nodeModulesPath is the path to the "node_modules" folder
         */
        function getTypingNamesFromNodeModuleFolder(nodeModulesPath: string, filesToWatch: string[]) {
            // Todo: add support for ModuleResolutionHost too
            if (!host.directoryExists(nodeModulesPath)) {
                return;
            }

            const typingNames: string[] = [];
            const jsonFiles = host.readDirectory(nodeModulesPath, "*.json", /*exclude*/ undefined, /*depth*/ 2);
            for (const jsonFile of jsonFiles) {
                if (getBaseFileName(jsonFile) !== "package.json") { continue; }
                const { config: packageJsonDictionary, error } = readConfigFile(jsonFile, host.readFile);
                if (error) { continue; }

                filesToWatch.push(jsonFile);

                // npm 3 has the package.json contains a "_requiredBy" field
                // we should include all the top level module names for npm 2, and only module names whose
                // "_requiredBy" field starts with "#" or equals "/" for npm 3.
                if (packageJsonDictionary._requiredBy &&
                    filter(packageJsonDictionary._requiredBy, (r: string) => r[0] === "#" || r === "/").length === 0) {
                    continue;
                }

                // If the package has its own d.ts typings, those will take precedence. Otherwise the package name will be used
                // to download d.ts files from DefinitelyTyped
                const packageName = packageJsonDictionary["name"];
                if (hasProperty(packageJsonDictionary, "typings")) {
                    const absolutePath = getNormalizedAbsolutePath(packageJsonDictionary.typings, getDirectoryPath(jsonFile));
                    inferredTypings[packageName] = absolutePath;
                }
                else {
                    typingNames.push(packageName);
                }
            }
            mergeTypings(typingNames);
        }

        function getTypingNamesFromCompilerOptions(options: CompilerOptions) {
            const typingNames: string[] = [];
            if (!options) {
                return;
            }
            mergeTypings(typingNames);
        }
    }

    /**
     * Keep a list of typings names that we know cannot be obtained at the moment (could be because
     * of network issues or because the package doesn't hava a d.ts file in DefinitelyTyped), so
     * that we won't try again next time within this session.
     * @param newTypingNames The list of new typings that the host attempted to acquire
     * @param cachePath The path to the tsd.json cache
     * @param host The object providing I/O related operations.
     */
    export function updateNotFoundTypingNames(newTypingNames: string[], cachePath: string, host: TypingResolutionHost): void {
        const tsdJsonPath = combinePaths(cachePath, "tsd.json");
        const { config: cacheTsdJsonDictionary, error } = readConfigFile(tsdJsonPath, host.readFile);
        if (!error) {
            const installedTypingFiles = hasProperty(cacheTsdJsonDictionary, "installed")
                ? getKeys(cacheTsdJsonDictionary.installed)
                : [];
            const newMissingTypingNames =
                filter(newTypingNames, name => hasProperty(notFoundTypingNames, name) && !isInstalled(name, installedTypingFiles));
            for (const newMissingTypingName of newMissingTypingNames) {
                notFoundTypingNames[newMissingTypingName] = undefined;
            }
        }
    }

    function isInstalled(typing: string, installedKeys: string[]) {
        const typingPrefix = typing + "/";
        for (const key of installedKeys) {
            if (key.indexOf(typingPrefix) === 0) {
                return true;
            }
        }
        return false;
    }
}
