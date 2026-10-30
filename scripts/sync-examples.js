"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MANIFEST_NAME = "ueditorplus-build-manifest.json";
const EXAMPLE_TARGETS = [
    "_examples-integrate/vue2/public/static/UEditorPlus",
    "_examples-integrate/vue3/public/static/UEditorPlus",
    "_examples-integrate/reactx/public/static/UEditorPlus"
];

function comparePaths(left, right) {
    return left < right ? -1 : (left > right ? 1 : 0);
}

function fail(message) {
    throw new Error(message);
}

function isWithin(parent, candidate) {
    const relative = path.relative(parent, candidate);
    return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

function requireDirectory(directory, description) {
    let stat;
    try {
        stat = fs.lstatSync(directory);
    } catch (error) {
        fail(`${description} is missing: ${directory}`);
    }
    if (stat.isSymbolicLink()) {
        fail(`${description} must not be a symbolic link: ${directory}`);
    }
    if (!stat.isDirectory()) {
        fail(`${description} is not a directory: ${directory}`);
    }
}

function requireNoSymlinkComponents(absolutePath, description) {
    const resolved = path.resolve(absolutePath);
    const parsed = path.parse(resolved);
    let current = parsed.root;
    const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
    segments.forEach((segment, index) => {
        current = path.join(current, segment);
        let stat;
        try {
            stat = fs.lstatSync(current);
        } catch (error) {
            if (error && error.code === "ENOENT") {
                fail(`${description} path component is missing: ${current}`);
            }
            throw error;
        }
        if (stat.isSymbolicLink()) {
            fail(`${description} path contains a symbolic link: ${current}`);
        }
        if (index < segments.length - 1 && !stat.isDirectory()) {
            fail(`${description} path component is not a directory: ${current}`);
        }
    });
}

function hashBuffer(value) {
    return crypto.createHash("sha256").update(value).digest("hex");
}

function scanTree(root, description) {
    requireDirectory(root, description);
    const files = [];
    const directories = [];

    function visit(directory, relativeDirectory) {
        const entries = fs.readdirSync(directory).sort(comparePaths);
        entries.forEach((name) => {
            if (name === "." || name === ".." || name.includes("\0") || name.includes("\\")) {
                fail(`${description} contains an invalid path entry: ${name}`);
            }
            const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
            const absolutePath = path.join(directory, name);
            const stat = fs.lstatSync(absolutePath);
            if (stat.isSymbolicLink()) {
                fail(`${description} contains a symbolic link: ${relativePath}`);
            }
            if (stat.isDirectory()) {
                directories.push(relativePath);
                visit(absolutePath, relativePath);
                return;
            }
            if (!stat.isFile()) {
                fail(`${description} contains an unsupported filesystem entry: ${relativePath}`);
            }
            const contents = fs.readFileSync(absolutePath);
            files.push({
                path: relativePath,
                size: stat.size,
                sha256: hashBuffer(contents),
                mode: stat.mode & 0o777
            });
        });
    }

    visit(root, "");
    files.sort((left, right) => comparePaths(left.path, right.path));
    directories.sort(comparePaths);
    return { files, directories };
}

function fingerprint(files) {
    const canonical = files
        .map((file) => `${file.path}\0${file.size}\0${file.sha256}\n`)
        .join("");
    return hashBuffer(canonical);
}

function makeManifest(repoRoot, distFiles, minFiles) {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const distHash = fingerprint(distFiles);
    const minHash = fingerprint(minFiles);
    const buildId = hashBuffer(`${packageJson.version}\n${distHash}\n${minHash}\n`);
    const records = (files) => files.map(({ path: filePath, size, sha256 }) => ({ path: filePath, size, sha256 }));
    const manifest = {
        schema: "ueditor-plus-static-sync/v1",
        packageVersion: String(packageJson.version),
        buildId,
        artifacts: {
            dist: { sha256: distHash, files: records(distFiles) },
            "dist-min": { sha256: minHash, files: records(minFiles) }
        }
    };
    return JSON.stringify(manifest, null, 2) + "\n";
}

function expectedDirectories(files) {
    const output = new Set();
    files.forEach((file) => {
        const segments = file.split("/");
        for (let index = 1; index < segments.length; index += 1) {
            output.add(segments.slice(0, index).join("/"));
        }
    });
    return output;
}

function inspectTargets(repoRoot, distFiles, manifestContent) {
    const expectedFiles = new Set(distFiles.map((file) => file.path));
    if (expectedFiles.has(MANIFEST_NAME)) {
        fail(`dist already contains reserved manifest path: ${MANIFEST_NAME}`);
    }
    expectedFiles.add(MANIFEST_NAME);
    const expectedDirs = expectedDirectories(Array.from(expectedFiles));

    return EXAMPLE_TARGETS.map((relativeTarget) => {
        const target = path.resolve(repoRoot, relativeTarget);
        if (!isWithin(repoRoot, target) || target === repoRoot) {
            fail(`example target escapes repository root: ${relativeTarget}`);
        }
        requireNoSymlinkComponents(repoRoot, "repository root");
        requireNoSymlinkComponents(target, `example target ${relativeTarget}`);
        requireDirectory(target, `example target ${relativeTarget}`);
        const inventory = scanTree(target, `example target ${relativeTarget}`);
        const actualFiles = new Set(inventory.files.map((file) => file.path));
        const actualDirs = new Set(inventory.directories);
        const extras = Array.from(actualFiles).filter((file) => !expectedFiles.has(file));
        const extraDirs = Array.from(actualDirs).filter((directory) => !expectedDirs.has(directory));
        const typeConflicts = Array.from(expectedFiles).filter((file) => actualDirs.has(file));

        if (extras.length) {
            fail(`example target ${relativeTarget} contains unexpected files; no files were removed: ${extras.join(", ")}`);
        }
        if (extraDirs.length) {
            fail(`example target ${relativeTarget} contains unexpected directories; no directories were removed: ${extraDirs.join(", ")}`);
        }
        if (typeConflicts.length) {
            fail(`example target ${relativeTarget} has directories where files are expected: ${typeConflicts.join(", ")}`);
        }

        const targetFiles = new Map(inventory.files.map((file) => [file.path, file]));
        const expectedSource = new Map(distFiles.map((file) => [file.path, file]));
        const missing = Array.from(expectedFiles).filter((file) => !actualFiles.has(file));
        const changed = [];
        for (const [filePath, expected] of expectedSource) {
            const actual = targetFiles.get(filePath);
            if (actual && (actual.size !== expected.size || actual.sha256 !== expected.sha256)) {
                changed.push(filePath);
            }
        }
        const actualManifest = targetFiles.get(MANIFEST_NAME);
        if (actualManifest && fs.readFileSync(path.join(target, MANIFEST_NAME), "utf8") !== manifestContent) {
            changed.push(MANIFEST_NAME);
        }

        return { relativeTarget, target, missing, changed, distFiles, manifestContent };
    });
}

function ensureExpectedDirectories(target, files) {
    const directories = Array.from(expectedDirectories(files)).sort((left, right) => {
        const depth = left.split("/").length - right.split("/").length;
        return depth || comparePaths(left, right);
    });
    directories.forEach((relativeDirectory) => {
        const absoluteDirectory = path.join(target, ...relativeDirectory.split("/"));
        try {
            const stat = fs.lstatSync(absoluteDirectory);
            if (stat.isSymbolicLink() || !stat.isDirectory()) {
                fail(`refusing unsafe target directory: ${relativeDirectory}`);
            }
        } catch (error) {
            if (error && error.code !== "ENOENT") {
                throw error;
            }
            fs.mkdirSync(absoluteDirectory);
        }
    });
}

function atomicCopy(source, destination, mode) {
    const temporary = path.join(
        path.dirname(destination),
        `.${path.basename(destination)}.sync-${process.pid}-${crypto.randomBytes(8).toString("hex")}`
    );
    let created = false;
    try {
        const sourceStat = fs.lstatSync(source);
        if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
            fail(`refusing unsafe source file: ${source}`);
        }
        fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
        created = true;
        fs.chmodSync(temporary, mode);
        fs.renameSync(temporary, destination);
        created = false;
    } finally {
        if (created) {
            try {
                fs.unlinkSync(temporary);
            } catch (error) {
                if (!error || error.code !== "ENOENT") {
                    throw error;
                }
            }
        }
    }
}

function atomicWrite(destination, contents) {
    const temporary = path.join(
        path.dirname(destination),
        `.${path.basename(destination)}.sync-${process.pid}-${crypto.randomBytes(8).toString("hex")}`
    );
    let descriptor;
    let created = false;
    try {
        descriptor = fs.openSync(temporary, "wx", 0o644);
        created = true;
        fs.writeFileSync(descriptor, contents, "utf8");
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporary, destination);
        created = false;
    } finally {
        if (descriptor !== undefined) {
            fs.closeSync(descriptor);
        }
        if (created) {
            try {
                fs.unlinkSync(temporary);
            } catch (error) {
                if (!error || error.code !== "ENOENT") {
                    throw error;
                }
            }
        }
    }
}

function prepare(repoRoot) {
    const root = path.resolve(repoRoot);
    requireNoSymlinkComponents(root, "repository root");
    requireDirectory(root, "repository root");
    const distRoot = path.join(root, "dist");
    const minRoot = path.join(root, "dist-min");
    const dist = scanTree(distRoot, "dist artifact");
    const distMin = scanTree(minRoot, "dist-min artifact");
    const manifestContent = makeManifest(root, dist.files, distMin.files);
    const targets = inspectTargets(root, dist.files, manifestContent);
    return { root, distRoot, distFiles: dist.files, manifestContent, targets };
}

function checkExamples(options = {}) {
    const prepared = prepare(options.repoRoot || path.resolve(__dirname, ".."));
    const mismatches = [];
    prepared.targets.forEach((target) => {
        if (target.missing.length || target.changed.length) {
            mismatches.push(
                `${target.relativeTarget}: missing=[${target.missing.join(", ")}], changed=[${target.changed.join(", ")}]`
            );
        }
    });
    if (mismatches.length) {
        fail(`example bundles do not match dist; run npm run build to regenerate them\n${mismatches.join("\n")}`);
    }
    const buildId = JSON.parse(prepared.manifestContent).buildId;
    return { buildId, targets: prepared.targets.map((target) => target.relativeTarget) };
}

function syncExamples(options = {}) {
    const prepared = prepare(options.repoRoot || path.resolve(__dirname, ".."));
    const expectedPaths = prepared.distFiles.map((file) => file.path).concat(MANIFEST_NAME);

    prepared.targets.forEach((target) => ensureExpectedDirectories(target.target, expectedPaths));
    prepared.targets.forEach((target) => {
        prepared.distFiles.forEach((file) => {
            const source = path.join(prepared.distRoot, ...file.path.split("/"));
            const destination = path.join(target.target, ...file.path.split("/"));
            atomicCopy(source, destination, file.mode);
        });
        atomicWrite(path.join(target.target, MANIFEST_NAME), prepared.manifestContent);
    });

    return checkExamples({ repoRoot: prepared.root });
}

function runCli(argv) {
    if (argv.length !== 1 || (argv[0] !== "--sync" && argv[0] !== "--check")) {
        process.stderr.write("Usage: node scripts/sync-examples.js --sync|--check\n");
        process.exitCode = 2;
        return;
    }
    try {
        const result = argv[0] === "--sync" ? syncExamples() : checkExamples();
        process.stdout.write(
            `${argv[0] === "--sync" ? "Synchronized" : "Verified"} ${result.targets.length} example bundles; buildId=${result.buildId}\n`
        );
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}

if (require.main === module) {
    runCli(process.argv.slice(2));
}

module.exports = { checkExamples, syncExamples, MANIFEST_NAME, EXAMPLE_TARGETS };
