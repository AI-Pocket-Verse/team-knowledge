/**
 * 把粘贴板里的 HTML 解析成一个可操作的容器。
 *
 * 不能用 `document.createElement("div").innerHTML = html`：即使这个 div 没挂到页面上，
 * 浏览器解析时也会加载 `<img src=x onerror=...>` 并触发 onerror，剪贴板内容由其他网页写入，
 * 等于允许任意页面在粘贴时执行脚本。DOMParser 产出的是惰性文档，不加载资源、不执行事件属性。
 */
export function parseClipboardHtml(html: string): HTMLElement {
  return new DOMParser().parseFromString(html, "text/html").body;
}
