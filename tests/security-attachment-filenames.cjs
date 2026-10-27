const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const attachmentSource = fs.readFileSync(path.join(root, 'dialogs/attachment/attachment.js'), 'utf8');
const insertFileSource = fs.readFileSync(path.join(root, '_src/plugins/insertfile.js'), 'utf8');

function extractFunction(source, marker, occurrence = 0) {
    let start = -1;
    let from = 0;
    for (let index = 0; index <= occurrence; index++) {
        start = source.indexOf(marker, from);
        assert.notEqual(start, -1, `missing function marker: ${marker}`);
        from = start + marker.length;
    }

    const open = start + marker.lastIndexOf('{');
    assert.notEqual(open, -1, `missing function body: ${marker}`);
    let depth = 0;
    let quote = null;
    let lineComment = false;
    let blockComment = false;

    for (let index = open; index < source.length; index++) {
        const char = source[index];
        const next = source[index + 1];

        if (lineComment) {
            if (char === '\n') lineComment = false;
            continue;
        }
        if (blockComment) {
            if (char === '*' && next === '/') {
                blockComment = false;
                index++;
            }
            continue;
        }
        if (quote) {
            if (char === '\\') {
                index++;
            } else if (char === quote) {
                quote = null;
            }
            continue;
        }
        if (char === '/' && next === '/') {
            lineComment = true;
            index++;
            continue;
        }
        if (char === '/' && next === '*') {
            blockComment = true;
            index++;
            continue;
        }
        if (char === "'" || char === '"' || char === '`') {
            quote = char;
            continue;
        }
        if (char === '{') depth++;
        if (char === '}' && --depth === 0) {
            return source.slice(open + 1, index);
        }
    }

    assert.fail(`unterminated function body: ${marker}`);
}

function loadAttachmentMethod(marker, dom, editor, occurrence = 0) {
    const body = extractFunction(attachmentSource, marker, occurrence);
    const parameterList = marker.match(/function\s*\(([^)]*)\)/)?.[1] || '';
    return vm.runInNewContext(`(function (${parameterList}) {${body}\n})`, {
        document: dom.window.document,
        editor,
        domUtils: {
            on(element, event, listener) {
                element.addEventListener(event, listener);
            },
            addClass(element, name) {
                element.classList.add(name);
            },
            hasClass(element, name) {
                return element.classList.contains(name);
            }
        }
    });
}

function makeOnlineList(dom) {
    const list = dom.window.document.createElement('ul');
    const clearFloat = dom.window.document.createElement('li');
    list.appendChild(clearFloat);
    dom.window.document.body.appendChild(list);
    return { list, clearFloat };
}

function makeJQuery(dom) {
    class Wrapper {
        constructor(element) {
            this.element = element;
        }

        attr(name, value) {
            if (value === undefined) return this.element.getAttribute(name);
            this.element.setAttribute(name, String(value));
            return this;
        }

        find(selector) {
            return new Wrapper(this.element.querySelector(selector));
        }

        text(value) {
            if (value === undefined) return this.element.textContent;
            this.element.textContent = String(value);
            return this;
        }

        appendTo(parent) {
            unwrap(parent).appendChild(this.element);
            return this;
        }

        append(child) {
            this.element.appendChild(unwrap(child));
            return this;
        }

        empty() {
            this.element.replaceChildren();
            return this;
        }

        addClass(name) {
            this.element.classList.add(...String(name).split(/\s+/).filter(Boolean));
            return this;
        }

        hide() { return this; }
        show() { return this; }
        on() { return this; }
        off() { return this; }
        remove() { this.element.remove(); return this; }
        removeClass(name) { this.element.classList.remove(...String(name).split(/\s+/).filter(Boolean)); return this; }
        css() { return this; }
        width() { return this; }
        stop() { return this; }
        animate() { return this; }

        insertBefore(target) {
            const before = unwrap(target);
            before.parentNode.insertBefore(this.element, before);
            return this;
        }
    }

    function unwrap(value) {
        return value instanceof Wrapper ? value.element : value;
    }

    function $(input) {
        if (typeof input === 'string') {
            const template = dom.window.document.createElement('template');
            template.innerHTML = input;
            return new Wrapper(template.content.firstElementChild);
        }
        return new Wrapper(input);
    }

    return $;
}

function renderUploadQueueItem(dom, file, acceptedExtensions = file.ext.toLowerCase()) {
    const body = extractFunction(attachmentSource, 'function addFile(file) {');
    const $ = makeJQuery(dom);
    const queue = dom.window.document.createElement('ul');
    const filePickerBlock = dom.window.document.createElement('li');
    queue.appendChild(filePickerBlock);
    const addFile = vm.runInNewContext(`(function (file) {${body}\n})`, {
        $,
        $filePickerBlock: $(filePickerBlock),
        lang: {
            uploadDelete: 'delete',
            uploadTurnRight: 'rotate right',
            uploadTurnLeft: 'rotate left',
            uploadPreview: 'preview',
            uploadNoPreview: 'no preview',
            errorFileType: 'type error',
            errorExceedSize: 'size error',
            errorInterrupt: 'interrupted',
            errorHttp: 'http error',
            errorUploadRetry: 'retry'
        },
        percentages: {},
        acceptExtensions: acceptedExtensions,
        uploader: {
            removeFile() {
                assert.fail('allowed PDF file should not be removed');
            }
        },
        updateTotalProgress() {},
        browser: { ie: false, version: 99 },
        thumbnailWidth: 100,
        thumbnailHeight: 100,
        supportTransition: true
    });
    addFile(file);
    return queue.firstElementChild;
}

function createInsertFileCommand(dom) {
    let factory;
    dom.window.UE = {
        plugin: {
            register(name, callback) {
                assert.equal(name, 'insertfile');
                factory = callback;
            }
        }
    };
    dom.window.utils = { isArray: Array.isArray };
    dom.window.eval(insertFileSource);
    assert.equal(typeof factory, 'function', 'the real insertfile plugin factory is registered');

    let insertedHtml = '';
    const editor = {
        options: { themePath: '/themes/', theme: 'default' },
        getOpt(name) {
            return name === 'UEDITOR_HOME_URL' ? '/' : '';
        },
        fireEvent(name) {
            return name === 'beforeinsertfile' ? false : undefined;
        },
        execCommand(command, html) {
            assert.equal(command, 'insertHtml');
            insertedHtml = html;
        }
    };
    const plugin = factory.call(editor);
    return {
        insert(files) {
            plugin.commands.insertfile.execCommand('insertfile', files);
            const container = dom.window.document.createElement('div');
            container.innerHTML = insertedHtml;
            return container;
        },
        editor
    };
}

test('online attachment list renders file names as text and keeps image preview URLs', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'https://editor.example.test/',
        runScripts: 'outside-only'
    });
    const editor = {
        getOpt(name) {
            return name === 'fileManagerUrlPrefix' ? '/files' : '';
        }
    };
    const pushData = loadAttachmentMethod('pushData: function (list) {', dom, editor);
    const manager = makeOnlineList(dom);
    const maliciousName = '<img src=x onerror=globalThis.filenameXss=1>.pdf';
    const fallbackName = '<svg onload=globalThis.fallbackXss=1>.pdf';
    const filenames = [
        'proposal.pdf',
        "计划's 📎.pdf",
        maliciousName,
        fallbackName
    ];

    pushData.call(manager, filenames.map((original, index) => ({
        ...(index === filenames.length - 1 ? {} : { original }),
        url: index === filenames.length - 1 ? `/download/${fallbackName}` : `/download/${index}.pdf`
    })));

    const renderedTitles = [...manager.list.querySelectorAll('.file-title')];
    assert.deepEqual(renderedTitles.map(node => node.textContent), filenames);
    assert.ok(renderedTitles.every(node => node.childElementCount === 0));
    assert.equal(manager.list.querySelector('img[onerror]'), null);
    assert.equal(manager.list.querySelector('svg[onload]'), null);

    pushData.call(manager, [{ url: '/images/legal-preview.jpg', original: 'preview.jpg' }]);
    const preview = manager.list.querySelector('img');
    assert.ok(preview, 'image entries still render an image preview');
    assert.match(preview.getAttribute('src'), /^\/files\/images\/legal-preview\.jpg\?noCache=/);
    assert.equal(manager.list.lastElementChild.previousElementSibling.getAttribute('data-url'), '/files/images/legal-preview.jpg');

    dom.window.close();
});

test('upload queue renders a selected malicious filename only as text', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'https://editor.example.test/',
        runScripts: 'outside-only'
    });
    const maliciousName = `"><img src=x onerror=globalThis.queueXss=1> & ' 📎.pdf`;
    const item = renderUploadQueueItem(dom, {
        id: 'uploader-file-1',
        name: maliciousName,
        ext: 'pdf',
        size: 17,
        rotation: 0,
        getStatus() { return 'queued'; },
        on() {}
    });

    assert.equal(item.querySelector('p.title').textContent, maliciousName);
    assert.equal(item.querySelector('.file-title').textContent, maliciousName);
    assert.equal(item.querySelector('.file-title').getAttribute('title'), maliciousName);
    assert.equal(item.querySelectorAll('img[onerror], svg[onload]').length, 0);
    assert.equal(item.querySelectorAll('.file-type-pdf').length, 1);

    const maliciousExtension = 'pdf"><img src=x onerror=globalThis.extensionXss=1>';
    const extensionItem = renderUploadQueueItem(dom, {
        id: 'uploader-file-2',
        name: `report.${maliciousExtension}`,
        ext: maliciousExtension,
        size: 17,
        rotation: 0,
        getStatus() { return 'queued'; },
        on() {}
    });
    assert.equal(extensionItem.querySelector('.file-title').textContent, `report.${maliciousExtension}`);
    assert.equal(extensionItem.querySelector('.file-title').getAttribute('title'), `report.${maliciousExtension}`);
    assert.equal(extensionItem.querySelectorAll('img[onerror], svg[onload]').length, 0);

    dom.window.close();
});

test('selected online and uploaded attachment names stay raw until insertfile safely encodes them', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'https://editor.example.test/',
        runScripts: 'outside-only'
    });
    const maliciousName = `"><img src=x onerror=globalThis.filenameXss=1> & ' 📎.pdf`;
    const fallbackName = '<svg onload=globalThis.fallbackXss=1>.pdf';
    const onlineEditor = {
        getOpt(name) {
            return name === 'fileManagerUrlPrefix' ? '/files' : '';
        }
    };
    const pushData = loadAttachmentMethod('pushData: function (list) {', dom, onlineEditor);
    const onlineManager = makeOnlineList(dom);
    pushData.call(onlineManager, [
        { original: maliciousName, url: '/download/report.pdf?version=1&mode=raw' },
        { url: `/download/${fallbackName}` }
    ]);
    onlineManager.list.querySelector('li[data-title]').classList.add('selected');
    [...onlineManager.list.querySelectorAll('li:not(.clearFloat)')]
        .find(item => !item.hasAttribute('data-title'))
        .classList.add('selected');

    const getOnlineInsertList = loadAttachmentMethod('getInsertList: function () {', dom, onlineEditor, 1);
    const onlineFiles = getOnlineInsertList.call(onlineManager);
    assert.deepEqual(Array.from(onlineFiles, file => ({ ...file })), [{
        title: maliciousName,
        url: '/files/download/report.pdf?version=1&mode=raw'
    }, {
        title: fallbackName,
        url: `/files/download/${fallbackName}`
    }]);

    const getUploadedInsertList = loadAttachmentMethod('getInsertList: function () {', dom, {
        getOpt(name) {
            return name === 'fileUrlPrefix' ? '/uploads' : '';
        }
    }, 0);
    const uploadedFiles = getUploadedInsertList.call({
        fileList: [
            { original: maliciousName, url: '/stored/report.pdf?version=1&mode=raw' },
            { original: "计划's 📎.pdf", url: '/stored/plan.pdf' }
        ]
    });
    assert.deepEqual(Array.from(uploadedFiles, file => ({ ...file })), [{
        title: maliciousName,
        url: '/uploads/stored/report.pdf?version=1&mode=raw'
    }, {
        title: "计划's 📎.pdf",
        url: '/uploads/stored/plan.pdf'
    }]);

    const command = createInsertFileCommand(dom);
    for (const file of [...onlineFiles, ...uploadedFiles]) {
        const inserted = command.insert([file]);
        const link = inserted.querySelector('a');
        assert.equal(link.getAttribute('title'), file.title);
        assert.equal(link.querySelector('span').textContent, file.title);
        assert.equal(link.querySelectorAll('[onerror]').length, 0);
        assert.equal(link.querySelectorAll('img').length, 1, 'only the editor file icon is present');
        assert.equal(link.getAttribute('href'), file.url);
    }

    dom.window.close();
});
