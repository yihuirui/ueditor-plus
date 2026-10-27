'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const REPO_ROOT = path.resolve(__dirname, '../..');

function makeDom(markup = '<!doctype html><html><head></head><body></body></html>', options = {}) {
    if (options.resources) {
        throw new Error('Security tests must not load external resources');
    }
    if (options.runScripts && options.runScripts !== 'outside-only') {
        throw new Error('Security tests must not execute inline scripts');
    }
    return new JSDOM(markup, {
        ...options,
        url: 'https://ueditor.test/',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
}

function loadIntoWindow(dom, repoRelativePath) {
    if (!dom || !dom.window) {
        throw new TypeError('loadIntoWindow requires a JSDOM instance');
    }
    if (typeof repoRelativePath !== 'string' || path.isAbsolute(repoRelativePath)) {
        throw new TypeError('Expected a repository-relative script path');
    }
    const absolutePath = path.resolve(REPO_ROOT, repoRelativePath);
    if (absolutePath !== REPO_ROOT && !absolutePath.startsWith(REPO_ROOT + path.sep)) {
        throw new Error('Script path must stay inside the checkout');
    }
    const relativePath = path.relative(REPO_ROOT, absolutePath).split(path.sep).join('/');
    const source = fs.readFileSync(absolutePath, 'utf8');
    dom.window.eval(source + '\n//# sourceURL=' + relativePath);
    return dom.window;
}

module.exports = { REPO_ROOT, makeDom, loadIntoWindow };
