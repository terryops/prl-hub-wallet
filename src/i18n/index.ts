import en from "./en.json" with { type: "json" };
import ru from "./ru.json" with { type: "json" };
import hans from "./zh-Hans.json" with { type: "json" };
import hant from "./zh-Hant.json" with { type: "json" };
import vi from "./vi.json" with { type: "json" };
import id from "./id.json" with { type: "json" };
import es from "./es.json" with { type: "json" };
import pt from "./pt-BR.json" with { type: "json" };
import fr from "./fr.json" with { type: "json" };
import de from "./de.json" with { type: "json" };
import it from "./it.json" with { type: "json" };
import tr from "./tr.json" with { type: "json" };
import ja from "./ja.json" with { type: "json" };
import ko from "./ko.json" with { type: "json" };
import hi from "./hi.json" with { type: "json" };
import th from "./th.json" with { type: "json" };
export const languages = ["en", "ru", "zh-Hans", "zh-Hant", "vi", "id", "es", "pt-BR", "fr", "de", "it", "tr", "ja", "ko", "hi", "th"] as const;
export type Lang = typeof languages[number];
export type TextKey = keyof typeof en;
export const dictionaries: Record<Lang, Record<TextKey, string>> = {
  "en": en,
  "ru": ru,
  "zh-Hans": hans,
  "zh-Hant": hant,
  "vi": vi,
  "id": id,
  "es": es,
  "pt-BR": pt,
  "fr": fr,
  "de": de,
  "it": it,
  "tr": tr,
  "ja": ja,
  "ko": ko,
  "hi": hi,
  "th": th
};
export const languageNames: Record<Lang, string> = {
  "en": "English",
  "ru": "Русский",
  "zh-Hans": "简体中文",
  "zh-Hant": "繁體中文",
  "vi": "Tiếng Việt",
  "id": "Bahasa Indonesia",
  "es": "Español",
  "pt-BR": "Português (Brasil)",
  "fr": "Français",
  "de": "Deutsch",
  "it": "Italiano",
  "tr": "Türkçe",
  "ja": "日本語",
  "ko": "한국어",
  "hi": "हिन्दी",
  "th": "ไทย"
};
export function isLanguage(value: unknown): value is Lang {
  return typeof value === "string" && languages.includes(value as Lang);
}
export function detectLanguage(preferences: readonly string[]): Lang {
  for (const raw of preferences) {
    const locale = raw.toLowerCase().replaceAll("_", "-");
    if (/^zh(?:-|$)/.test(locale)) {
      return /(?:^|-)hant(?:-|$)/.test(locale) || (!/(?:^|-)hans(?:-|$)/.test(locale) && /(?:^|-)(tw|hk|mo)(?:-|$)/.test(locale)) ? "zh-Hant" : "zh-Hans";
    }
    if (locale === "pt" || locale.startsWith("pt-")) return "pt-BR";
    const base = locale.split("-")[0];
    if (isLanguage(base)) return base;
  }
  return "en";
}
export function translate(lang: Lang, key: TextKey, values: Record<string, string | number> = {}): string {
  return dictionaries[lang][key].replace(/\{(\w+)\}/g, (match, name: string) => Object.hasOwn(values, name) ? String(values[name]) : match);
}
export function messageText(lang: Lang, message: string): string {
  // Do not leak untranslated low-level/network errors into the interface.
  return translate(lang, Object.hasOwn(en, message) ? message as TextKey : "操作失败。");
}
