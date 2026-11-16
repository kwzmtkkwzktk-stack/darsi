const TOOL_IDS = [
  "ai", "explain", "experiments", "law3d", "videos", "files", "quiz", "paper",
  "challenge", "path", "phys", "plan", "timer", "dates", "report", "res", "notes", "calc", "wheel"
];

const DEFAULT_SITE_SETTINGS = {
  site: {
    name: "دليني",
    tagline: "منصتك الدراسية العراقية",
    symbol: "د",
    pageTitle: "دليني | منصتك الدراسية العراقية",
    metaDescription: "منصة دليني التعليمية للطالب العراقي: ملازم ومحاضرات وامتحانات وخطة مذاكرة ومختبر قوانين تفاعلي.",
    backgroundImage: ""
  },
  hero: {
    eyebrow: "مساحتك للتعلّم والإنجاز",
    title: "أهلاً بك في دليني ✨",
    description: "كل أدوات دراستك بمكان واحد. خطوة صغيرة اليوم تصنع فرقاً كبيراً بالامتحان.",
    primaryLabel: "رتّب دراسة اليوم",
    secondaryLabel: "ابدأ اختباراً"
  },
  theme: {
    bg: "#f7f4ff", card: "#ffffff", glass: "#ffffff", text: "#2a2140",
    muted: "#8b839c", primary: "#7c3aed", primarySoft: "#f0e9ff",
    accent: "#ec4899", border: "#ebe4f7", dark: "#101827"
  },
  footer: {
    tipTitle: "نصيحة دليني لليوم",
    text: "دليني · رفيقك بالدراسة خطوة بخطوة 🇮🇶"
  },
  groups: {
    learn: { enabled: true, kicker: "ابدأ من هنا", title: "تعلّم وافهم", description: "مصادر وشرح يساعدك تستوعب الدرس" },
    practice: { enabled: true, kicker: "استعد بثقة", title: "تدرّب وامتحن", description: "اختبر معلوماتك وراجع نقاط ضعفك" },
    organize: { enabled: true, kicker: "نظّم وقتك", title: "خطّط وتابع", description: "خلّي دراستك واضحة وإنجازك محسوب" },
    stats: { enabled: true, kicker: "ملخص سريع", title: "لوحة إنجازك", description: "نظرة سريعة على نشاطك الدراسي" }
  },
  nav: { home: "الرئيسية", plan: "خطة اليوم", files: "الملازم", quiz: "الامتحانات", report: "إنجازي" },
  tools: {},
  customSections: []
};

function text(value, max, fallback = "") {
  return String(value == null ? fallback : value).trim().slice(0, max);
}
function color(value, fallback) {
  const v = String(value || "");
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback;
}
function safeUrl(value) {
  const v = text(value, 700);
  return /^(https?:\/\/|\/)(?!\/)/i.test(v) ? v : "";
}
function sanitizeSiteSettings(input) {
  const src = input && typeof input === "object" ? input : {};
  const d = DEFAULT_SITE_SETTINGS;
  const out = JSON.parse(JSON.stringify(d));

  for (const k of Object.keys(out.site)) {
    out.site[k] = text(src.site && src.site[k], k === "metaDescription" ? 300 : 180, d.site[k]);
  }
  out.site.backgroundImage = safeUrl(src.site && src.site.backgroundImage);
  for (const k of Object.keys(out.hero)) out.hero[k] = text(src.hero && src.hero[k], 500, d.hero[k]);
  for (const k of Object.keys(out.footer)) out.footer[k] = text(src.footer && src.footer[k], 240, d.footer[k]);

  for (const k of Object.keys(out.theme)) out.theme[k] = color(src.theme && src.theme[k], d.theme[k]);
  for (const key of Object.keys(out.groups)) {
    const x = src.groups && src.groups[key] || {};
    out.groups[key] = {
      enabled: x.enabled !== false,
      kicker: text(x.kicker, 80, d.groups[key].kicker),
      title: text(x.title, 120, d.groups[key].title),
      description: text(x.description, 240, d.groups[key].description)
    };
  }
  for (const k of Object.keys(out.nav)) out.nav[k] = text(src.nav && src.nav[k], 50, d.nav[k]);
  const suppliedTools = src.tools && typeof src.tools === "object" ? src.tools : {};
  for (const id of TOOL_IDS) {
    const t = suppliedTools[id];
    if (!t) continue;
    out.tools[id] = {
      visible: t.visible !== false,
      title: text(t.title, 120),
      description: text(t.description, 240)
    };
  }
  const blocks = Array.isArray(src.customSections) ? src.customSections : [];
  out.customSections = blocks.slice(0, 25).map((b, i) => ({
    id: text(b && b.id, 50, `block-${i + 1}`).replace(/[^a-zA-Z0-9_-]/g, ""),
    enabled: !b || b.enabled !== false,
    icon: text(b && b.icon, 8, "✦"),
    kicker: text(b && b.kicker, 80),
    title: text(b && b.title, 140, "قسم جديد"),
    body: text(b && b.body, 2500),
    buttonText: text(b && b.buttonText, 80),
    url: safeUrl(b && b.url),
    background: color(b && b.background, "#ffffff")
  }));
  return out;
}

module.exports = { TOOL_IDS, DEFAULT_SITE_SETTINGS, sanitizeSiteSettings };
