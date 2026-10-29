// واجهة المنصة الدراسية: الطلاب والنتائج والملازم والمحاضرات وأسئلة الامتحانات والإعلانات
const { ObjectId, Binary } = require("mongodb");

module.exports = function (app, db, express) {
  app.set("trust proxy", 1);

  const col = async (name) => (await db()).collection(name);
  const S = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
  const oid = (v) => (ObjectId.isValid(String(v)) ? new ObjectId(String(v)) : null);
  const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
  const need = (cond, msg) => { if (!cond) throw bad(msg); };
  const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d));

  const DEFAULTS = {
    grades: {
      "السادس الابتدائي": ["القرآن الكريم", "اللغة العربية", "الرياضيات", "العلوم", "الاجتماعيات", "اللغة الإنكليزية", "التربية الإسلامية"],
      "الثالث المتوسط": ["اللغة العربية", "اللغة الإنكليزية", "التربية الإسلامية", "الرياضيات", "الفيزياء", "الكيمياء", "الأحياء", "التاريخ", "الجغرافية"],
      "السادس الإعدادي (علمي)": ["اللغة العربية", "اللغة الإنكليزية", "التربية الإسلامية", "الرياضيات", "الفيزياء", "الكيمياء", "الأحياء"],
      "السادس الإعدادي (أدبي)": ["اللغة العربية", "اللغة الإنكليزية", "التربية الإسلامية", "التاريخ", "الجغرافية", "الاقتصاد", "الفلسفة"]
    },
    examNames: ["امتحان الشهر الأول", "امتحان الشهر الثاني", "امتحان الشهر الثالث", "امتحان نصف السنة", "الشهر الأول بعد نصف السنة", "الشهر الثاني بعد نصف السنة"],
    exams: [
      { n: "امتحان الشهر الأول", d: "2026-11-15" },
      { n: "امتحان الشهر الثاني", d: "2026-12-13" },
      { n: "امتحان الشهر الثالث", d: "2027-01-10" },
      { n: "امتحان نصف السنة", d: "2027-01-24" }
    ]
  };

  async function settings() {
    const d = (await (await col("st_settings")).findOne({ _id: "main" })) || {};
    return {
      grades: d.grades || DEFAULTS.grades,
      examNames: d.examNames || DEFAULTS.examNames,
      exams: d.exams || DEFAULTS.exams
    };
  }

  // ---- حماية بسيطة من التخمين ----
  const hits = new Map();
  const fails = new Map();
  function tooMany(key, max, ms) {
    const now = Date.now();
    const a = (hits.get(key) || []).filter((t) => now - t < ms);
    a.push(now);
    hits.set(key, a);
    if (hits.size > 5000) hits.clear();
    return a.length > max;
  }
  function adminOK(req, res) {
    const key = String(req.ip || "x");
    const now = Date.now();
    const a = (fails.get(key) || []).filter((t) => now - t < 600000);
    if (a.length >= 15) { res.sendStatus(429); return false; }
    const pass = String(req.get("x-admin") || (req.body && req.body.pass) || "");
    if (process.env.ADMIN_CODE && pass === process.env.ADMIN_CODE) return true;
    a.push(now);
    fails.set(key, a);
    if (fails.size > 5000) fails.clear();
    res.sendStatus(401);
    return false;
  }
  const fail = (res, e) => {
    if (e && e.status) return res.status(e.status).json({ error: e.message });
    console.error("Study API error:", e && e.message);
    res.status(500).json({ error: "حدث خطأ في الخادم" });
  };
  const gradeFilter = (g) => (g ? { $or: [{ grade: g }, { grade: "" }] } : {});

  // =============== للعرض العام ===============
  app.get("/api/study/info", async (req, res) => {
    try {
      const s = await settings();
      const news = await (await col("st_news")).find({}).sort({ date: -1 }).limit(5).toArray();
      res.set("Cache-Control", "no-store");
      res.json({
        grades: s.grades,
        examNames: s.examNames,
        exams: s.exams,
        news: news.map((n) => ({ id: String(n._id), title: n.title, text: n.text || "", image: n.image ? "/api/img/" + n.image : "", date: n.date }))
      });
    } catch (e) { fail(res, e); }
  });

  const fileOut = (f) => ({ id: String(f._id), title: f.title, subject: f.subject || "", grade: f.grade || "", name: f.name, type: f.type, size: f.size, date: f.date });

  app.get("/api/study/files", async (req, res) => {
    try {
      const l = await (await col("st_files")).find(gradeFilter(S(req.query.grade, 80))).sort({ date: -1 }).limit(500).toArray();
      res.set("Cache-Control", "no-store");
      res.json(l.map(fileOut));
    } catch (e) { fail(res, e); }
  });

  app.get("/api/study/file/:id", async (req, res) => {
    const id = oid(req.params.id);
    if (!id) return res.sendStatus(404);
    try {
      const f = await (await col("st_files")).findOne({ _id: id });
      const b = await (await col("st_blobs")).findOne({ _id: id });
      if (!f || !b) return res.sendStatus(404);
      const buf = Buffer.from(b.data.buffer);
      res.set({
        "Content-Type": f.type,
        "Content-Disposition": (req.query.dl ? "attachment" : "inline") + "; filename*=UTF-8''" + encodeURIComponent(f.name),
        "Content-Length": String(buf.length),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox",
        "Cache-Control": "public, max-age=3600"
      });
      res.send(buf);
    } catch (e) { fail(res, e); }
  });

  const videoOut = (v) => ({ id: String(v._id), title: v.title, subject: v.subject || "", grade: v.grade || "", url: v.url, desc: v.desc || "", cover: v.cover ? "/api/img/" + v.cover : "", date: v.date });

  app.get("/api/study/videos", async (req, res) => {
    try {
      const l = await (await col("st_videos")).find(gradeFilter(S(req.query.grade, 80))).sort({ date: -1 }).limit(500).toArray();
      res.set("Cache-Control", "no-store");
      res.json(l.map(videoOut));
    } catch (e) { fail(res, e); }
  });

  const qOut = (q) => ({ id: String(q._id), grade: q.grade || "", subject: q.subject, chapter: q.chapter, q: q.q, a: q.a, o: q.o || [] });

  app.get("/api/study/questions", async (req, res) => {
    try {
      const l = await (await col("st_questions")).find(gradeFilter(S(req.query.grade, 80))).sort({ date: 1 }).limit(3000).toArray();
      res.set("Cache-Control", "no-store");
      res.json(l.map(qOut));
    } catch (e) { fail(res, e); }
  });

  app.post("/api/study/result", async (req, res) => {
    if (tooMany("r" + (req.ip || "x"), 40, 600000)) return res.sendStatus(429);
    try {
      const code = S(req.body && req.body.code, 20).replace(/\D/g, "");
      if (code.length < 4) return res.sendStatus(404);
      const d = await (await col("st_students")).findOne({ _id: code });
      if (!d) return res.sendStatus(404);
      res.set("Cache-Control", "no-store");
      res.json({ n: d.n, g: d.g, x: d.x || {}, ab: d.ab || [] });
    } catch (e) { fail(res, e); }
  });

  // =============== رفع الملازم (المدير فقط) ===============
  const TYPES = {
    pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
    doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  };
  const MAGIC = {
    pdf: [0x25, 0x50, 0x44, 0x46], jpg: [0xff, 0xd8], jpeg: [0xff, 0xd8], png: [0x89, 0x50, 0x4e, 0x47], webp: [0x52, 0x49, 0x46, 0x46],
    doc: [0xd0, 0xcf], ppt: [0xd0, 0xcf], docx: [0x50, 0x4b], pptx: [0x50, 0x4b]
  };

  app.post("/api/study/upload", express.raw({ type: () => true, limit: "15mb" }), async (req, res) => {
    if (!adminOK(req, res)) return;
    try {
      let name, meta;
      try {
        name = S(decodeURIComponent(req.get("x-filename") || "ملف"), 160);
        meta = JSON.parse(decodeURIComponent(req.get("x-meta") || "{}"));
      } catch (e) { throw bad("بيانات الملف غير صحيحة"); }

      const ext = (name.split(".").pop() || "").toLowerCase();
      need(TYPES[ext], "نوع الملف غير مدعوم (PDF أو صورة أو Word أو PowerPoint)");
      const buf = Buffer.isBuffer(req.body) ? req.body : null;
      need(buf && buf.length > 0, "الملف فارغ");
      need(MAGIC[ext].every((b, i) => buf[i] === b), "محتوى الملف لا يطابق نوعه");

      const title = S(meta.title, 200) || name;
      const st = await settings();
      const grade = S(meta.grade, 80);
      need(!grade || st.grades[grade], "الصف غير صحيح");

      const id = new ObjectId();
      const files = await col("st_files");
      await files.insertOne({ _id: id, title, subject: S(meta.subject, 80), grade, name, type: TYPES[ext], size: buf.length, date: new Date() });
      try {
        await (await col("st_blobs")).insertOne({ _id: id, data: new Binary(buf) });
      } catch (e) {
        await files.deleteOne({ _id: id });
        throw e;
      }
      res.json({ ok: true, id: String(id) });
    } catch (e) { fail(res, e); }
  });

  // =============== إجراءات الإدارة ===============
  async function newCode(c) {
    for (let i = 0; i < 30; i++) {
      const code = String(Math.floor(1e9 + Math.random() * 9e9));
      if (!(await c.findOne({ _id: code }))) return code;
    }
    throw bad("تعذر توليد رمز جديد", 500);
  }

  async function remove(name, id, blobToo) {
    const _id = oid(id);
    need(_id, "معرّف غير صحيح");
    await (await col(name)).deleteOne({ _id });
    if (blobToo) await (await col("st_blobs")).deleteOne({ _id });
    return { ok: true };
  }
  async function upsert(name, id, doc) {
    const c = await col(name);
    if (id) {
      const _id = oid(id);
      need(_id, "معرّف غير صحيح");
      await c.updateOne({ _id }, { $set: doc });
    } else {
      await c.insertOne({ ...doc, date: new Date() });
    }
    return { ok: true };
  }
  const validGrade = async (g) => { const st = await settings(); need(!g || st.grades[g], "الصف غير صحيح"); return g; };

  const A = {
    check: async () => ({ ok: true }),

    "settings.get": async () => settings(),
    "settings.save": async (b) => {
      const set = {};
      if (b.grades) {
        const g = {};
        const names = Object.keys(b.grades).slice(0, 30);
        for (const k of names) {
          const n = S(k, 80);
          const subs = (Array.isArray(b.grades[k]) ? b.grades[k] : []).map((x) => S(x, 80)).filter(Boolean).slice(0, 30);
          if (n && subs.length) g[n] = subs;
        }
        need(Object.keys(g).length, "أضف صفاً واحداً على الأقل");
        set.grades = g;
      }
      if (b.examNames) set.examNames = (Array.isArray(b.examNames) ? b.examNames : []).map((x) => S(x, 80)).filter(Boolean).slice(0, 12);
      if (b.exams) set.exams = (Array.isArray(b.exams) ? b.exams : []).filter((e) => e && S(e.n, 80) && isDate(e.d)).map((e) => ({ n: S(e.n, 80), d: String(e.d) })).slice(0, 20);
      await (await col("st_settings")).updateOne({ _id: "main" }, { $set: set }, { upsert: true });
      return { ok: true };
    },

    "students.list": async () =>
      (await (await col("st_students")).find({}).sort({ n: 1 }).limit(3000).toArray()).map((s) => ({ code: s._id, n: s.n, g: s.g, x: s.x || {}, ab: s.ab || [] })),

    "students.save": async (b) => {
      const st = await settings();
      const n = S(b.n, 120);
      need(n, "اسم الطالب مطلوب");
      const g = S(b.g, 80);
      need(st.grades[g], "اختر الصف");
      const x = {};
      for (const [k, v] of Object.entries(b.x || {})) {
        if (!/^\d{1,2}$/.test(k) || !Array.isArray(v) || !v.length) continue;
        need(v.length <= 20 && v.every((m) => typeof m === "number" && m >= 0 && m <= 100), "درجات غير صحيحة (من 0 إلى 100)");
        x[k] = v;
      }
      const ab = (Array.isArray(b.ab) ? b.ab : []).map(String).filter(isDate).slice(0, 300);
      const c = await col("st_students");
      let code = S(b.code, 20).replace(/\D/g, "");
      if (!code) code = await newCode(c);
      else need(code.length >= 6, "الرمز قصير (6 أرقام على الأقل)");
      await c.updateOne({ _id: code }, { $set: { n, g, x, ab, updatedAt: new Date() } }, { upsert: true });
      return { ok: true, code };
    },

    "students.bulk": async (b) => {
      const st = await settings();
      const g = S(b.g, 80);
      need(st.grades[g], "اختر الصف");
      const names = (Array.isArray(b.names) ? b.names : []).map((x) => S(x, 120)).filter(Boolean).slice(0, 500);
      need(names.length, "اكتب اسماً واحداً على الأقل");
      const c = await col("st_students");
      const out = [];
      for (const n of names) {
        const code = await newCode(c);
        await c.insertOne({ _id: code, n, g, x: {}, ab: [], updatedAt: new Date() });
        out.push({ code, n });
      }
      return { ok: true, list: out };
    },

    "students.delete": async (b) => {
      await (await col("st_students")).deleteOne({ _id: S(b.code, 20) });
      return { ok: true };
    },

    "files.list": async () => (await (await col("st_files")).find({}).sort({ date: -1 }).limit(500).toArray()).map(fileOut),
    "files.delete": async (b) => remove("st_files", b.id, true),

    "videos.list": async () => (await (await col("st_videos")).find({}).sort({ date: -1 }).limit(500).toArray()).map(videoOut),
    "videos.save": async (b) => {
      const url = S(b.url, 500);
      need(/^https?:\/\//i.test(url), "رابط الفيديو يجب أن يبدأ بـ https://");
      const title = S(b.title, 200);
      need(title, "عنوان المحاضرة مطلوب");
      const cover = b.cover && oid(b.cover) ? String(b.cover) : "";
      return upsert("st_videos", b.id, { title, url, subject: S(b.subject, 80), grade: await validGrade(S(b.grade, 80)), desc: S(b.desc, 1000), cover });
    },
    "videos.delete": async (b) => remove("st_videos", b.id),

    "questions.list": async () => (await (await col("st_questions")).find({}).sort({ date: -1 }).limit(3000).toArray()).map(qOut),
    "questions.save": async (b) => {
      const q = S(b.q, 600), a = S(b.a, 400);
      const o = (Array.isArray(b.o) ? b.o : []).map((x) => S(x, 400));
      need(q && a, "السؤال والجواب الصحيح مطلوبان");
      need(o.length === 3 && o.every(Boolean), "أدخل ثلاثة خيارات خاطئة");
      const subject = S(b.subject, 80), chapter = S(b.chapter, 80);
      need(subject && chapter, "المادة والفصل مطلوبان");
      return upsert("st_questions", b.id, { q, a, o, subject, chapter, grade: await validGrade(S(b.grade, 80)) });
    },
    "questions.delete": async (b) => remove("st_questions", b.id),

    "news.list": async () => (await (await col("st_news")).find({}).sort({ date: -1 }).limit(100).toArray()).map((n) => ({ id: String(n._id), title: n.title, text: n.text || "", image: n.image || "" })),
    "news.save": async (b) => {
      const title = S(b.title, 200);
      need(title, "عنوان الإعلان مطلوب");
      return upsert("st_news", b.id, { title, text: S(b.text, 2000), image: b.image && oid(b.image) ? String(b.image) : "" });
    },
    "news.delete": async (b) => remove("st_news", b.id),

    // امتحانات ورقية (يضيفها الأدمن يدوياً — الذكاء الاصطناعي يصحّح فقط)
    "paper.list": async () =>
      (await (await col("st_paper")).find({}).sort({ date: -1 }).limit(200).toArray()).map((p) => ({
        id: String(p._id),
        grade: p.grade || "",
        subject: p.subject || "",
        questions: Array.isArray(p.questions) ? p.questions : [],
        date: p.date
      })),
    "paper.save": async (b) => {
      const grade = await validGrade(S(b.grade, 80));
      const subject = S(b.subject, 80);
      need(grade, "اختر الصف");
      need(subject, "المادة مطلوبة");
      const questions = (Array.isArray(b.questions) ? b.questions : [])
        .map((q) => S(q, 800))
        .filter(Boolean)
        .slice(0, 20);
      need(questions.length >= 3, "أضف 3 أسئلة على الأقل");
      need(questions.length <= 20, "الحد الأقصى 20 سؤالاً");
      return upsert("st_paper", b.id, { grade, subject, questions });
    },
    "paper.delete": async (b) => remove("st_paper", b.id)
  };


  // ===================== الامتحانات الورقية (AI) =====================
  // يدعم OpenRouter (الأولوية) ثم Gemini ثم OpenAI.
  // OpenRouter: ضع OPENROUTER_API_KEY في إعدادات السيرفر
  // موديل افتراضي: openai/gpt-4o-mini (يمكن تغييره بـ OPENROUTER_MODEL)
  async function callAI(messages, maxTokens = 2000) {
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    if (openrouterKey) {
      return callOpenRouter(messages, maxTokens, openrouterKey);
    }
    if (geminiKey) {
      return callGemini(messages, maxTokens, geminiKey);
    }
    if (openaiKey) {
      return callOpenAI(messages, maxTokens, openaiKey);
    }
    throw bad("خدمة الذكاء الاصطناعي غير مفعّلة. أضف OPENROUTER_API_KEY (مفضّل) أو GEMINI_API_KEY أو OPENAI_API_KEY في إعدادات السيرفر.", 503);
  }

  async function callOpenRouter(messages, maxTokens, key) {
    const model = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "https://darsi.app",
        "X-Title": process.env.OPENROUTER_APP_NAME || "Darsi"
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature: 0.4
      })
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      console.error("OpenRouter error:", r.status, t.slice(0, 400));
      throw bad("تعذر الاتصال بخدمة الذكاء الاصطناعي حالياً، حاول لاحقاً.", 502);
    }
    const j = await r.json();
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
  }

  async function callGemini(messages, maxTokens, key) {
    // تحويل صيغة OpenAI إلى صيغة Gemini
    const systemParts = [];
    const contents = [];
    for (const m of messages) {
      if (m.role === "system") {
        systemParts.push(typeof m.content === "string" ? m.content : "");
        continue;
      }
      const role = m.role === "assistant" ? "model" : "user";
      const parts = [];
      if (typeof m.content === "string") {
        parts.push({ text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p.type === "text") parts.push({ text: p.text });
          else if (p.type === "image_url" && p.image_url && p.image_url.url) {
            const url = p.image_url.url;
            const m2 = /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(url);
            if (m2) {
              parts.push({ inline_data: { mime_type: m2[1] === "image/jpg" ? "image/jpeg" : m2[1], data: m2[2] } });
            }
          }
        }
      }
      if (parts.length) contents.push({ role, parts });
    }

    const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
    const body = {
      contents,
      generationConfig: { temperature: 0.4, maxOutputTokens: maxTokens }
    };
    if (systemParts.length) {
      body.systemInstruction = { parts: [{ text: systemParts.join("\n") }] };
    }

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      console.error("Gemini error:", r.status, t.slice(0, 400));
      throw bad("تعذر الاتصال بخدمة الذكاء الاصطناعي حالياً، حاول لاحقاً.", 502);
    }
    const j = await r.json();
    const parts = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
    return (parts && parts.map(p => p.text || "").join("")) || "";
  }

  async function callOpenAI(messages, maxTokens, key) {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4o",
        messages,
        max_tokens: maxTokens,
        temperature: 0.4
      })
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      console.error("OpenAI error:", r.status, t.slice(0, 300));
      throw bad("تعذر الاتصال بخدمة الذكاء الاصطناعي حالياً، حاول لاحقاً.", 502);
    }
    const j = await r.json();
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
  }

  // جلب أسئلة الامتحان الورقي من قاعدة البيانات (يضيفها الأدمن)
  app.post("/api/study/paper/generate", async (req, res) => {
    if (tooMany("pg" + (req.ip || "x"), 20, 600000)) return res.sendStatus(429);
    try {
      const grade = S(req.body && req.body.grade, 80);
      const subject = S(req.body && req.body.subject, 80);
      need(grade && subject, "الصف والمادة مطلوبان");

      const doc = await (await col("st_paper")).findOne({ grade, subject });
      need(doc && Array.isArray(doc.questions) && doc.questions.length >= 3,
        "لا يوجد امتحان ورقي لهذه المادة بعد. أضفه من صفحة الإدارة.");

      const questions = doc.questions.map((q) => String(q).trim()).filter(Boolean).slice(0, 20);

      res.json({
        grade,
        subject,
        questions,
        createdAt: Date.now()
      });
    } catch (e) { fail(res, e); }
  });

  // تصحيح الامتحان الورقي من صورة
  app.post("/api/study/paper/grade", async (req, res) => {
    if (tooMany("pr" + (req.ip || "x"), 6, 600000)) return res.sendStatus(429);
    try {
      const grade = S(req.body && req.body.grade, 80);
      const subject = S(req.body && req.body.subject, 80);
      const questions = Array.isArray(req.body && req.body.questions) ? req.body.questions.map(q => String(q).trim()).filter(Boolean) : [];
      const image = String(req.body && req.body.image || "");

      need(grade && subject, "الصف والمادة مطلوبان");
      need(questions.length >= 3, "الأسئلة ناقصة");
      need(/^data:image\/(jpeg|jpg|png|webp);base64,/.test(image), "صورة غير صالحة");

      const qList = questions.map((q, i) => `${i + 1}. ${q}`).join("\n");

      const totalQ = questions.length;
      const system = `أنت مصحح امتحانات عراقي دقيق ومنصف جداً.
ستصلك صورة لورقة إجابة طالب + قائمة الأسئلة.

مهمتك:
1. اقرأ إجابات الطالب من الصورة بعناية (حتى لو كانت بخط اليد).
2. قيّم كل سؤال بدرجة جزئية حسب الدقة:
   - 1    = صح كامل (الإجابة صحيحة تماماً أو بمعنى مطابق)
   - 0.5  = نص صح (فهم الفكرة لكن ناقص أو فيه خطأ جزئي مهم)
   - 0.25 = ربع صح (محاولة قريبة أو جزء صغير صحيح فقط)
   - 0    = خطأ كامل (ما كتب شيئاً مفيداً أو إجابة خاطئة تماماً)
3. كن منصفاً: إذا الإجابة قريبة بالمعنى اعتبرها صح أو نص صح، لا تتعنت.
4. اكتب ملاحظة قصيرة وواضحة لكل سؤال.
5. الدرجة النهائية = مجموع درجات الأسئلة (من ${totalQ}).

أرجع JSON فقط بهذا الشكل بدون أي نص إضافي:
{
  "score": 6.75,
  "total": ${totalQ},
  "percent": 68,
  "summary": "ملخص قصير عن مستوى الطالب",
  "details": [
    {"n":1,"mark":1,"label":"صح","note":"إجابة صحيحة كاملة"},
    {"n":2,"mark":0.5,"label":"نص صح","note":"الفكرة صحيحة لكن ناقصة ..."},
    {"n":3,"mark":0.25,"label":"ربع صح","note":"محاولة قريبة، الصحيح تقريباً ..."},
    {"n":4,"mark":0,"label":"خطأ","note":"الإجابة غير صحيحة، الصحيح ..."}
  ]
}`;

      const userContent = [
        { type: "text", text: `الصف: ${grade}\nالمادة: ${subject}\n\nالأسئلة:\n${qList}\n\nصحّح إجابات الطالب من الصورة التالية بدقة مع الدرجات الجزئية (1 / 0.5 / 0.25 / 0) وأرجع JSON فقط.` },
        { type: "image_url", image_url: { url: image, detail: "high" } }
      ];

      const content = await callAI([
        { role: "system", content: system },
        { role: "user", content: userContent }
      ], 3000);

      let result;
      try {
        const cleaned = content.replace(/```json|```/g, "").trim();
        result = JSON.parse(cleaned);
      } catch (e) {
        throw bad("تعذر قراءة نتيجة التصحيح، حاول بصورة أوضح.");
      }

      const total = totalQ;
      const allowed = [0, 0.25, 0.5, 1];
      const labelOf = (m) => (m >= 1 ? "صح" : m >= 0.5 ? "نص صح" : m >= 0.25 ? "ربع صح" : "خطأ");
      const details = (Array.isArray(result.details) ? result.details : []).slice(0, 20).map((d) => {
        let mark = Number(d.mark);
        if (!allowed.includes(mark)) {
          // توافق مع الصيغة القديمة ok
          if (d.ok === true) mark = 1;
          else if (d.ok === false) mark = 0;
          else mark = 0;
        }
        return {
          n: Number(d.n) || 0,
          mark,
          label: labelOf(mark),
          ok: mark >= 0.5,
          note: String(d.note || "").slice(0, 300)
        };
      });

      // احسب الدرجة من التفاصيل إن وُجدت، وإلا من score القادم من النموذج
      let score = details.length
        ? details.reduce((s, d) => s + (Number(d.mark) || 0), 0)
        : Number(result.score) || 0;
      score = Math.round(Math.max(0, Math.min(total, score)) * 100) / 100;
      const percent = total ? Math.round((score / total) * 100) : 0;

      res.json({
        score,
        total,
        percent,
        summary: String(result.summary || "").slice(0, 400),
        details
      });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/study/admin", async (req, res) => {
    if (!adminOK(req, res)) return;
    const h = Object.prototype.hasOwnProperty.call(A, req.body && req.body.action) ? A[req.body.action] : null;
    if (!h) return res.sendStatus(400);
    try { res.json(await h(req.body || {})); } catch (e) { fail(res, e); }
  });
};
 
 
