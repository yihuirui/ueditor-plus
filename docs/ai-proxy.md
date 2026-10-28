# AI 对话框同源代理接入

内置 AI 驱动只向宿主配置的同源后端发请求。浏览器不再直连 OpenAI、DeepSeek 或其他模型服务，也不发送模型 API Key。仓库没有提供可直接公开部署的 AI 代理实现；宿主必须接入自己的受认证后端。

## 浏览器配置

在编辑器启动前配置 `ai.driver` 和 `ai.driverConfig`：

```js
window.UEDITOR_CONFIG.ai = {
  driver: 'Proxy',
  driverConfig: {
    url: '/api/ueditor/ai',
    // 从宿主服务端渲染的 CSRF meta 标签读取当前会话 token。
    // 通过函数读取可支持 token 轮换；不要把固定 token 写进静态脚本。
    csrfToken: function () {
      var element = document.querySelector('meta[name="csrf-token"]');
      return element ? element.content : '';
    }
  }
};
```

`url` 必须明确配置且解析为编辑器页面的同源 HTTP(S) 地址。空值、外域地址（包括指向外域的协议相对 URL）、用户名或密码 URL 都会在 `fetch` 前拒绝；请求使用 `mode: 'same-origin'`、`credentials: 'same-origin'` 和 `redirect: 'error'`。没有隐式的厂商 URL 回退。

内置请求会在每次提交时读取 `csrfToken`。它可以是非空字符串，也可以是返回当前非空字符串的函数。请求头包含 `X-CSRF-Token`，请求体只有编辑器生成的 `systemPromptText` 和 `promptText`。模型、上游地址和模型 Key 不从浏览器发送；服务端应根据自己的固定配置决定上游和模型。

旧配置中的 `driverConfig.key` 只用于识别并拒绝迁移前配置：只要非空，无论是否设置自定义 `driverRequest`，代码都不会调用 `fetch` 或回调，并提示从前端删除 Key、迁移到服务端。运行时拒绝请求不会从已下载的配置脚本或浏览器内存中抹掉旧 Key；部署前必须删除该字段并轮换曾经暴露的 Key。旧的 `OpenAi`、`DeepSeek`、`Anthropic` 等内置直连驱动返回迁移错误。宿主仍可在 `key` 为空时提供 `driverRequest(option)` 对接自己的服务端；该回调由宿主负责身份认证和 CSRF，不能在浏览器中恢复供应商 Key。

## 服务端安全要求

不要把代理部署成匿名、可任意指定上游的公开转发器。至少应：

- 用当前登录会话认证用户；从服务端会话确定用户身份，不信任请求体中的身份字段。
- 验证与当前会话绑定的 `X-CSRF-Token`，并按部署需要校验 Origin/Referer。前端使用同源凭据并发送自定义 header 不能替代服务端校验。
- 对用户、租户和模型实施额度、速率限制、并发限制、请求体大小限制及上游超时；限制 prompt 长度和可返回的最大 token 数。
- 在服务端固定并允许白名单上游、模型和 endpoint；不要接受浏览器传入的 URL 或任意 provider 选择。
- 把供应商 API Key 放在服务端环境变量或密钥管理服务中，禁止回传到浏览器、日志或 SSE 响应。

## 请求与 SSE 响应合同

内置客户端发送：

```http
POST /api/ueditor/ai
Accept: text/event-stream
Content-Type: application/json
X-CSRF-Token: <当前会话 token>
```

```json
{
  "systemPromptText": "业务系统提示语",
  "promptText": "当前操作提示及选区/文档上下文"
}
```

成功响应使用 UTF-8 `text/event-stream`，每个 JSON 事件放在单行 `data:` 中，并以空行分隔。服务端需要返回一个结束事件；客户端也兼容 `[DONE]` 结束标记。最小合同如下：

```text
data: {"type":"data","data":"生成内容片段"}

data: {"type":"data","data":"后续片段"}

data: {"type":"end"}

```

失败可返回非 2xx HTTP 状态，或在流中返回 `data: {"type":"error","data":"可向用户展示的错误"}`。错误字符串会作为文本显示。若连接在 `end`/`[DONE]` 前关闭，客户端将报告流不完整，不把部分结果标记为成功。

浏览器仅展示生成结果；用户点击“插入”或“替换”后才会写入编辑器。HTML 预览及 HTML 插入会调用宿主 `parent.UE.sanitizeHtml(html)`；若 sanitizer 缺失、抛错或没有返回字符串，HTML 结果不会显示或插入。单行纯文本使用文本节点或 HTML 编码。

## 迁移与验证边界

1. 删除浏览器脚本、页面配置和运行时 `driverConfig.key`，轮换曾经发布过的供应商 Key。
2. 配置同源受保护后端、当前会话 CSRF token getter 和服务端环境 Key。
3. 将旧 provider 驱动改为 `Proxy`；需要自定义适配时使用无浏览器模型 Key 的 `driverRequest` 回调。
4. 在真实宿主验证 session、CSRF、限流、额度、超时、上游白名单和日志脱敏。

当前仓库没有接入真实业务后端；本说明定义的是客户端/代理协议，不代表生产代理已部署或真实模型请求已打通。
