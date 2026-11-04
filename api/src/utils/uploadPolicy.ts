// 通用附件上传的扩展名黑名单(网页上传与飞书附件导入共用一份)。
// 下载路由会按检测出的类型或 octet-stream 提供文件，并加 nosniff，这里再挡一层：
// 能被浏览器当作网页、脚本或可执行程序的扩展名一律不收。
export const BLOCKED_UPLOAD_EXT = new Set([
  // 可执行程序与安装包
  "exe", "bat", "cmd", "com", "scr", "msi", "dll", "sys", "jar", "app", "dmg", "hta", "wasm",
  // 脚本
  "vbs", "vbe", "js", "mjs", "cjs", "jse", "es", "ecma", "ws", "wsf", "wsh",
  "ps1", "psm1", "sh", "bash", "zsh",
  // 网页与可执行标记
  "html", "htm", "shtml", "xht", "xhtml", "xhtm", "mht", "mhtml",
  "svg", "svgz", "xml", "xsl", "xslt",
]);
