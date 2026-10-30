var contentImport = {};
var g = $G;

contentImport.data = {
    result: null,
};
contentImport.init = function (opt, callbacks) {
    addUploadButtonListener();
    addOkListener();
};
function clearImportPreview() {
    var result = document.querySelector(".file-result");
    if (result) {
        result.textContent = "";
    }
    $(".file-result").hide();
}
function sanitizeImportHtml(html) {
    var ue = parent && parent.UE;
    if (!ue || typeof ue.sanitizeHtml !== "function") {
        throw new Error("HTML净化不可用，已拒绝导入");
    }
    var clean = ue.sanitizeHtml(html);
    if (typeof clean !== "string") {
        throw new Error("HTML净化失败，已拒绝导入");
    }
    return clean;
}
function renderImportResult(html, successMessage) {
    contentImport.data.result = null;
    try {
        var clean = sanitizeImportHtml(html);
        var result = document.querySelector(".file-result");
        if (!result) {
            throw new Error("导入预览不可用");
        }
        // jQuery 1.10 is intentionally kept by this project. Assign only the
        // sanitized string through the browser DOM; jQuery .html() can rewrite
        // sanitized markup in affected old versions.
        result.innerHTML = clean;
        contentImport.data.result = clean;
        $(".file-result").show();
        $(".file-tip").text(successMessage || "转换成功");
        return true;
    } catch (error) {
        clearImportPreview();
        $(".file-tip").text(error && error.message ? error.message : "内容净化失败，已拒绝导入");
        return false;
    }
}
function upload (blob) {
     /* 创建Ajax并提交 
        暂时采用同步方式
        异步的话，可以自行参考 ueditor.all.js 23031开始 进行修改
         */
     var xhr = new XMLHttpRequest()
     var fd = new FormData()

     var url =  editor.getOpt('imageUrlPrefix')
    var actionUrl = editor.getActionUrl(editor.getOpt('imageActionName'))
    var type = 'png'
    if (blob.type) {
        type = blob.type.substr('image/'.length)
    }
    fd.append('upfile', blob, blob.name || ('blob.' + type))
    fd.append('type', 'ajax')
    xhr.open('post', actionUrl, false)
    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest')

    xhr.send(fd)
    if (xhr.status == 200) {
        var json;
        try {
            json = JSON.parse(xhr.responseText);
        } catch (e) {
            return blob;
        }
        if (json.state == 'SUCCESS' && json.url) {
            return url + json.url
        } else {
            return blob
        }
    }

}
function processWord(file) {
    $('.file-tip').text('正在转换Word文件，请稍后...');
    contentImport.data.result = null;
    clearImportPreview();
    var reader = new FileReader();
    reader.onload = function (loadEvent) {
        mammoth.convertToHtml({
            arrayBuffer: loadEvent.target.result
        }, {
            convertImage: mammoth.images.imgElement(function (image) {
                return image.readAsArrayBuffer().then(function (imageBuffer) {
                    // 创建blob URL而不是base64

                    const blob = new Blob([imageBuffer], { type: image.contentType })
                    const url = upload(blob)
                   //若是只要展示 直接blob形式就可以，采用下面这行
                    // const url = URL.createObjectURL(blob)

                    return {
                        src: url,
                        alt: '文档图片'
                    }
                })
            })
        })
            .then(function displayResult(result) {
                renderImportResult(result.value);
            }, function (error) {
                contentImport.data.result = null;
                clearImportPreview();
                $('.file-tip').text('Word文件转换失败:' + error);
            });
    };
    reader.onerror = function (loadEvent) {
        contentImport.data.result = null;
        clearImportPreview();
        $('.file-tip').text('Word文件转换失败:' + loadEvent);
    };
    reader.readAsArrayBuffer(file);
}

function processMarkdown( markdown ){
    var converter = new showdown.Converter();
    var html = converter.makeHtml(markdown);
    renderImportResult(html);
}

function processMarkdownFile(file) {
    $('.file-tip').text('正在转换Markdown文件，请稍后...');
    contentImport.data.result = null;
    clearImportPreview();
    var reader = new FileReader();
    reader.onload = function (loadEvent) {
        processMarkdown( loadEvent.target.result );
    };
    reader.onerror = function (loadEvent) {
        contentImport.data.result = null;
        clearImportPreview();
        $('.file-tip').text('Markdown文件转换失败:' + loadEvent);
    };
    reader.readAsText(file, "UTF-8");
}

function addUploadButtonListener() {
    g('contentImport').addEventListener('change', function () {
        const file = this.files[0];
        const fileName = file.name;
        const fileExt = fileName.substring(fileName.lastIndexOf('.') + 1).toLowerCase();
        switch (fileExt) {
            case 'docx':
            case 'doc':
                processWord(file);
                break;
            case 'md':
                processMarkdownFile(file);
                break;
            default:
                contentImport.data.result = null;
                clearImportPreview();
                $('.file-tip').text('不支持的文件格式:' + fileExt);
                break;
        }
    });
    g('fileInputConfirm').addEventListener('click', function () {
        processMarkdown( g('fileInputContent').value );
        $('.file-input').hide();
    });
}

function addOkListener() {
    dialog.onok = function () {
        if (!contentImport.data.result) {
            alert('请先上传文件识别内容');
            return false;
        }
        try {
            // Sanitize again at confirmation because other dialog listeners may
            // alter the stored preview value after it was rendered.
            contentImport.data.result = sanitizeImportHtml(contentImport.data.result);
        } catch (error) {
            contentImport.data.result = null;
            clearImportPreview();
            $('.file-tip').text(error && error.message ? error.message : '内容净化失败，已拒绝导入');
            return false;
        }
        editor.fireEvent('saveScene');
        editor.execCommand("inserthtml", contentImport.data.result);
        editor.fireEvent('saveScene');
    };
    dialog.oncancel = function () {
    };
}
