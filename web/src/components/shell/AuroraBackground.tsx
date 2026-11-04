export function AuroraBackground({ children }: { children: React.ReactNode }) {
  // 飞书云文档是纯平白底(无渐变 / 无光晕)。这里保留一个 fixed 占位层,纯粹是为了
  // 让后代 `position: sticky`(如文档大纲 TOC)相对视口锚定,而不是被某个
  // overflow 裁切的祖先困住;背景本身用纯白,贴合飞书的干净平面。
  return (
    <>
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 bg-bg" />
      <div className="relative min-h-screen">{children}</div>
    </>
  );
}
