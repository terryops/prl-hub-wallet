// PostCSS plugin for the Android app builds (the Android wallet here and prl-hub-web keep the same copy in
// web/scripts/old-webview-css.mjs). The phone's System WebView can be as old as Chrome 82 where Google Play doesn't
// update it. The build's cssTarget lowers what Lightning CSS can; this adds fallbacks for the rest the app uses:
// - dvh/svh/lvh (Chrome 108) were dropped, so the wallet frame shrank to an iframe's 150 px: vh goes first.
// - color-mix() (Chrome 111) was dropped, tints vanished and borders took the text colour: its last colour goes first.
// - Container queries (Chrome 105) were ignored, so 矿池 kept the wide table: a container is never wider than the
//   screen, so a max-width-only one is repeated as a media query (min-width ones are left alone).
// A value with var() is accepted when parsed and dropped only when computed, after it has beaten the fallback in
// front of it; there, as for custom properties, the new value moves behind @supports instead.
const VIEWPORT = "(height: 1dvh)";
const MIX = "(color: color-mix(in srgb, red, blue))";
const MAX_WIDTH_ONLY = /^\(\s*max-width\s*:\s*[\d.]+px\s*\)$/;

/** Each color-mix(in …, A p%, B q%) becomes B. */
export function withoutColorMix(value) {
  const start = value.indexOf("color-mix(");
  if (start < 0) return value;
  let depth = 0;
  let lastComma = -1;
  let end = start + "color-mix".length;
  for (; end < value.length; end++) {
    const c = value[end];
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) break;
    else if (c === "," && depth === 1) lastComma = end;
  }
  const last = value.slice(lastComma + 1, end).trim().replace(/\s+[\d.]+%$/, "");
  return value.slice(0, start) + withoutColorMix(last) + withoutColorMix(value.slice(end + 1));
}

export const oldWebViewCss = () => ({
  postcssPlugin: "old-webview-css",
  Declaration(decl, { AtRule }) {
    const rule = decl.parent;
    if (rule?.parent?.type === "atrule" && rule.parent.name === "supports" && [VIEWPORT, MIX].some((s) => rule.parent.params.includes(s))) return;
    const needs = [];
    let fallback = decl.value;
    if (/\d[dsl]vh\b/.test(fallback)) {
      fallback = fallback.replace(/(\d)[dsl]vh\b/g, "$1vh");
      needs.push(VIEWPORT);
    }
    if (fallback.includes("color-mix(")) {
      fallback = withoutColorMix(fallback);
      needs.push(MIX);
    }
    if (!needs.length) return;
    if (/\bvar\(/.test(decl.value) || decl.prop.startsWith("--")) {
      if (rule?.type !== "rule") return;
      const supports = new AtRule({ name: "supports", params: needs.join(" and ") });
      supports.append(rule.clone({ nodes: [] }).append(decl.clone()));
      rule.after(supports);
      decl.value = fallback;
      return;
    }
    const previous = decl.prev();
    if (previous?.type === "decl" && previous.prop === decl.prop && previous.value === fallback) return;
    decl.cloneBefore({ value: fallback });
  },
  AtRule: {
    container(rule, { AtRule }) {
      const condition = rule.params.replace(/^[\w-]+\s+(?=\()/, "").trim();
      if (!MAX_WIDTH_ONLY.test(condition)) return;
      const media = new AtRule({ name: "media", params: condition });
      media.append(rule.nodes.map((node) => node.clone()));
      const supports = new AtRule({ name: "supports", params: "not (container-type: inline-size)" });
      supports.append(media);
      rule.after(supports);
    },
  },
});
oldWebViewCss.postcss = true;
