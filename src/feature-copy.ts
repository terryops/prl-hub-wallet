import type { Lang } from "./i18n/index.ts";
// Existing B1 copy uses the same native wording as the wallet dictionaries.
export const featureCopy = {
  "en": {
    "secondary": "Secondary Currency",
    "auto": "Follow Language",
    "none": "Hide",
    "price": "PRL Price"
  },
  "ru": {
    "secondary": "Доп. валюта",
    "auto": "Как язык системы",
    "none": "Не показывать",
    "price": "Цена PRL"
  },
  "zh-Hans": {
    "secondary": "副货币",
    "auto": "跟随语言",
    "none": "不显示",
    "price": "PRL 币价"
  },
  "zh-Hant": {
    "secondary": "副貨幣",
    "auto": "跟隨語言",
    "none": "不顯示",
    "price": "PRL 幣價"
  },
  "vi": {
    "secondary": "Tiền tệ phụ",
    "auto": "Theo ngôn ngữ",
    "none": "Không hiển thị",
    "price": "Giá PRL"
  },
  "id": {
    "secondary": "Mata Uang Sekunder",
    "auto": "Ikuti Bahasa",
    "none": "Sembunyikan",
    "price": "Harga PRL"
  },
  "es": {
    "secondary": "Moneda secundaria",
    "auto": "Según el idioma",
    "none": "No mostrar",
    "price": "Precio de PRL"
  },
  "pt-BR": {
    "secondary": "Moeda secundária",
    "auto": "Seguir o idioma",
    "none": "Não mostrar",
    "price": "Preço do PRL"
  },
  "fr": {
    "secondary": "Devise secondaire",
    "auto": "Selon la langue",
    "none": "Aucune",
    "price": "Prix PRL"
  },
  "de": {
    "secondary": "Zweitwährung",
    "auto": "Wie Sprache",
    "none": "Ausblenden",
    "price": "PRL-Preis"
  },
  "it": {
    "secondary": "Valuta secondaria",
    "auto": "Come la lingua",
    "none": "Nascondi",
    "price": "Prezzo PRL"
  },
  "tr": {
    "secondary": "İkincil Para Birimi",
    "auto": "Dile Göre",
    "none": "Gösterme",
    "price": "PRL Fiyatı"
  },
  "ja": {
    "secondary": "サブ通貨",
    "auto": "言語に従う",
    "none": "非表示",
    "price": "PRL価格"
  },
  "ko": {
    "secondary": "보조 통화",
    "auto": "언어에 맞춤",
    "none": "표시 안 함",
    "price": "PRL 가격"
  },
  "hi": {
    "secondary": "दूसरी मुद्रा",
    "auto": "भाषा के अनुसार",
    "none": "न दिखाएँ",
    "price": "PRL कीमत"
  },
  "th": {
    "secondary": "สกุลเงินรอง",
    "auto": "ตามภาษา",
    "none": "ไม่แสดง",
    "price": "ราคา PRL"
  }
} as const;
export type FeatureKey = keyof typeof featureCopy.en;
export const featureText = (lang: Lang, key: FeatureKey) => featureCopy[lang][key];
