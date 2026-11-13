// Netlify serverless endpoint for the Dleeni smart blackboard.
// Configure one server-side secret: OPENROUTER_API_KEY, GEMINI_API_KEY, or OPENAI_API_KEY.
const recent = new Map();
const json = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  body: JSON.stringify(body)
});
const str = (v, max) => String(v == null ? "" : v).trim().slice(0, max);

function rateLimited(key) {
  const now = Date.now();
  const times = (recent.get(key) || []).filter((t) => now - t < 5 * 60 * 1000);
  times.push(now);
  recent.set(key, times);
  if (recent.size > 3000) recent.clear();
  return times.length > 8;
}

async function askAI(problem, subject, grade, image) {
  const system = `أنت مدرّسة عراقية خبيرة تشرح لطلاب المدارس وفق مستوى الصف المحدد. احچي باللهجة العراقية البيضاء الطبيعية وبأسلوب ودود ومشجّع، وحلّي المسائل بدقة وبأسلوب مبسّط.
أخرج JSON صالحاً فقط بلا markdown وبالمفاتيح التالية حصراً:
{"title":"عنوان قصير","problem":"نص المسألة كما فهمته","finalAnswer":"الجواب النهائي مع الوحدة إن وجدت","spokenScript":"خلاصة منطوقة قصيرة باللهجة العراقية","steps":[{"title":"اسم الخطوة","equation":"القانون أو العملية الحسابية","explanation":"شرح مكتوب واضح","spoken":"كلام قصير تحچي بيه المدرّسة باللهجة العراقية عن هاي الخطوة"}],"check":"طريقة تحقق مختصرة أو فارغ","tip":"ملاحظة تعليمية مفيدة أو فارغ","needsClarification":false}
ابدأ بالمعطيات والمطلوب عند الحاجة، ثم القانون، ثم التعويض، ثم الحساب، ثم النتيجة. اجعل كل خطوة قصيرة قابلة للعرض منفردة على سبورة رقمية. استخدم معادلات نصية واضحة وتجنب LaTeX. في الفيزياء اذكر الوحدات والتحويلات، وفي الكيمياء الكتل المولية أو الموازنة عند الحاجة. لا تخترع قيماً غير ظاهرة بالصورة. إذا كانت الصورة غير واضحة أو تنقصها معطيات، اجعل needsClarification=true ولا تخمّن. اشرح بالعربية السهلة وراعِ مستوى الطالب العراقي. لكل خطوة أضيفي spoken: جملة أو جملتين باللهجة العراقية البيضاء الطبيعية، مثل (هسه، خلّينا، شوف، ننتبه)، وتكون سهلة النطق صوتياً من دون رموز معادلات معقدة. أضف spokenScript بخلاصة منطوقة من جملتين أو ثلاث باللهجة العراقية تشجع الطالب وتلخص النتيجة. لا تستخدم الفصحى الرسمية في الكلام المنطوق ولا تبالغ بالمفردات العامية. اجعل الخطوات من 2 إلى 10.`;
  const context = [
    "الصف الدراسي: " + (grade || "غير محدد"),
    "المادة: " + (subject || "حددها من السؤال"),
    "المسألة المكتوبة: " + (problem || "اقرأ المسألة من الصورة المرفقة.")
  ].join("\n");
  const keyRouter = process.env.OPENROUTER_API_KEY;
  const keyGemini = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const keyOpenAI = process.env.OPENAI_API_KEY;
  if (!keyRouter && !keyGemini && !keyOpenAI) {
    const e = new Error("خدمة الذكاء الاصطناعي غير مفعّلة. أضف OPENROUTER_API_KEY أو GEMINI_API_KEY أو OPENAI_API_KEY في إعدادات الاستضافة.");
    e.status = 503; throw e;
  }

  if (keyGemini && !keyRouter) {
    const parts = [{ text: system + "\n\n" + context }];
    if (image) {
      const m = /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(image);
      if (m) parts.push({ inline_data: { mime_type: m[1] === "image/jpg" ? "image/jpeg" : m[1], data: m[2] } });
    }
    const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${keyGemini}`;
    const response = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { temperature: 0.25, maxOutputTokens: 2200 } })
    });
    if (!response.ok) throw Object.assign(new Error("تعذر الاتصال بخدمة الذكاء الاصطناعي حالياً، حاول لاحقاً."), { status: 502 });
    const data = await response.json();
    return (((data.candidates || [])[0] || {}).content || {}).parts?.map((p) => p.text || "").join("") || "";
  }

  const content = image
    ? [{ type: "text", text: context }, { type: "image_url", image_url: { url: image } }]
    : context;
  const messages = [{ role: "system", content: system }, { role: "user", content }];
  if (keyRouter) {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer " + keyRouter,
        "content-type": "application/json",
        "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "https://darsi.app",
        "X-Title": process.env.OPENROUTER_APP_NAME || "Darsi"
      },
      body: JSON.stringify({ model: process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini", messages, max_tokens: 2200, temperature: 0.25 })
    });
    if (!response.ok) throw Object.assign(new Error("تعذر الاتصال بخدمة الذكاء الاصطناعي حالياً، حاول لاحقاً."), { status: 502 });
    const data = await response.json();
    return data.choices?.[0]?.message?.content || "";
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", headers: { authorization: "Bearer " + keyOpenAI, "content-type": "application/json" },
    body: JSON.stringify({ model: process.env.OPENAI_MODEL || "gpt-4o", messages, max_tokens: 2200, temperature: 0.25 })
  });
  if (!response.ok) throw Object.assign(new Error("تعذر الاتصال بخدمة الذكاء الاصطناعي حالياً، حاول لاحقاً."), { status: 502 });
  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "طريقة الطلب غير مدعومة." });
  if (rateLimited(event.headers?.["x-nf-client-connection-ip"] || event.headers?.["x-forwarded-for"] || "netlify-client")) {
    return json(429, { error: "وصلت للحد المؤقت من المحاولات. انتظر قليلاً ثم جرّب مرة ثانية." });
  }
  try {
    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch (_) { return json(400, { error: "تعذرت قراءة بيانات المسألة." }); }
    const problem = str(body.problem, 5000);
    const subject = str(body.subject, 80);
    const grade = str(body.grade, 80);
    const image = String(body.image || "");
    const img = /^data:image\/(?:jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/;
    if (!problem && !img.test(image)) return json(400, { error: "اكتب المسألة أو أرفق صورة واضحة لها." });
    if (image && !img.test(image)) return json(400, { error: "صيغة الصورة غير مدعومة. استخدم JPG أو PNG أو WEBP." });
    if (image.length > 1500000) return json(400, { error: "حجم الصورة كبير. اختر صورة أصغر أو التقط صورة جديدة." });

    const raw = String(await askAI(problem, subject, grade, image) || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) { try { parsed = JSON.parse(match[0]); } catch (_) {} }
    }
    if (!parsed || typeof parsed !== "object") {
      const lines = raw.split(/\r?\n/).map((x) => x.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).filter(Boolean).slice(0, 10);
      parsed = { title: "شرح المسألة", problem: problem || "مسألة من صورة", finalAnswer: lines.at(-1) || raw.slice(-500), steps: lines.map((line, i) => ({ title: "الخطوة " + (i + 1), equation: line, explanation: "" })), check: "", tip: "راجع الوحدات والمعطيات مع كتابك الدراسي.", needsClarification: false };
    }
    const steps = (Array.isArray(parsed.steps) ? parsed.steps : []).slice(0, 10).map((st, i) => ({
      title: str(st?.title, 100) || "الخطوة " + (i + 1),
      equation: str(st?.equation, 500),
      explanation: str(st?.explanation, 600),
      spoken: str(st?.spoken, 380) || str(st?.explanation, 380) || str(st?.title, 120)
    }));
    if (!steps.length) return json(502, { error: "لم أستطع استخراج خطوات واضحة. أعد كتابة المسألة بصورة أبسط." });
    return json(200, { ok: true, solution: {
      title: str(parsed.title, 120) || "حل المسألة", problem: str(parsed.problem, 1200) || problem || "مسألة من صورة",
      finalAnswer: str(parsed.finalAnswer, 700) || "راجع الخطوات أعلاه.",
      spokenScript: str(parsed.spokenScript, 1200) || ("وهسه خلصنا الحل. النتيجة هي: " + (str(parsed.finalAnswer, 500) || "راجع النتيجة المكتوبة فوق") + ". عاشت إيدك، راجع الخطوات حتى تثبت المعلومة."),
      steps,
      check: str(parsed.check, 500), tip: str(parsed.tip, 500), needsClarification: !!parsed.needsClarification
    } });
  } catch (e) {
    return json(e.status || 500, { error: e.message || "حدث خطأ غير متوقع." });
  }
};
