// Copy vendor CSS that must bypass Vite's PostCSS pipeline into public/vendor/.
//
// Why served as static <link> files instead of imported: Tailwind 3.4.x's
// collectLayerPlugins crashes on @milkdown/theme-nord's nested `@layer base {}`
// ("layerRule.nodes is not iterable"). Serving these as plain static files
// (referenced via <link> in index.html) keeps Tailwind from ever processing the
// at-rules. Regenerated on postinstall/predev/prebuild — do not hand-edit
// public/vendor/* (regenerated assets are gitignored).
import { mkdirSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function copyTree(fromDir, toDir) {
  mkdirSync(toDir, { recursive: true });
  for (const name of readdirSync(fromDir)) {
    const src = join(fromDir, name);
    const dst = join(toDir, name);
    if (statSync(src).isDirectory()) copyTree(src, dst);
    else copyFileSync(src, dst);
  }
}

const fileAssets = [
  {
    from: resolve(root, "node_modules/@milkdown/theme-nord/lib/style.css"),
    to:   resolve(root, "public/vendor/milkdown-nord.css"),
  },
  {
    from: resolve(root, "node_modules/@milkdown/crepe/lib/theme/nord/style.css"),
    to:   resolve(root, "public/vendor/crepe/nord.css"),
  },
  // prosemirror-view ships the editor reset (white-space: pre-wrap, etc.).
  // Crepe's bundled prosemirror.css uses `@import '@milkdown/kit/prose/...'`
  // which is a node-resolved path the browser cannot resolve, so the reset
  // silently fails to load — without `white-space: pre-wrap` the editor
  // re-layouts paragraphs on selection (the "text jumps up" symptom).
  // Serve the raw file ourselves so the rules actually apply.
  {
    from: resolve(root, "node_modules/prosemirror-view/style/prosemirror.css"),
    to:   resolve(root, "public/vendor/prosemirror-view.css"),
  },
  // Same node-resolved-import problem with prosemirror-virtual-cursor:
  // Crepe's cursor.css does `@import 'prosemirror-virtual-cursor/style/...'`,
  // which fails when served as a static asset. Without this CSS the
  // virtual-cursor element renders with no `position: absolute`,
  // `transform: translate(-1px)`, or `border-left` — it ends up
  // in-flow and shifts surrounding blocks when selection toggles
  // collapse/range (e.g. dblclick on a heading after the bubble
  // toolbar's wrapInHeadingCommand). Ship the official rule directly.
  {
    from: resolve(root, "node_modules/prosemirror-virtual-cursor/style/virtual-cursor.css"),
    to:   resolve(root, "public/vendor/prosemirror-virtual-cursor.css"),
  },
];

const treeAssets = [
  {
    from: resolve(root, "node_modules/@milkdown/crepe/lib/theme/common"),
    to:   resolve(root, "public/vendor/crepe/common"),
  },
];

for (const a of fileAssets) {
  mkdirSync(dirname(a.to), { recursive: true });
  copyFileSync(a.from, a.to);
  console.log(`[copy-vendor] ${a.from} → ${a.to}`);
}
for (const a of treeAssets) {
  copyTree(a.from, a.to);
  console.log(`[copy-vendor] (tree) ${a.from} → ${a.to}`);
}
