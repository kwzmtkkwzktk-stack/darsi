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
        questions: (Array.isArray(p.questions) ? p.questions : []).map((item) => {
          if (item && typeof item === "object") {
            return { q: String(item.q || "").trim(), a: String(item.a || "").trim() };
          }
          return { q: String(item || "").trim(), a: "" };
        }),
        date: p.date
      })),
    "paper.save": async (b) => {
      const grade = await validGrade(S(b.grade, 80));
      const subject = S(b.subject, 80);
      need(grade, "اختر الصف");
      need(subject, "المادة مطلوبة");
      const questions = (Array.isArray(b.questions) ? b.questions : [])
        .map((item) => {
          if (item && typeof item === "object") {
            return { q: S(item.q, 800), a: S(item.a, 800) };
          }
          return { q: S(item, 800), a: "" };
        })
        .filter((item) => item.q)
        .slice(0, 20);
      need(questions.length >= 3, "أضف 3 أسئلة على الأقل");
      need(questions.every((item) => item.a), "اكتب الجواب الصحيح لكل سؤال");
      return upsert("st_paper", b.id, { grade, subject, questions });
    },
    "paper.delete": async (b) => remove("st_paper", b.id),

    // نشاط الطلاب على المنصة (اسم، محافظة، صف، نتائج)
    "activity.list": async () => {
      const rows = await (await col("st_activity")).find({}).sort({ updatedAt: -1 }).limit(500).toArray();
      return rows.map((r) => ({
        id: String(r._id),
        name: r.name || "",
        school: r.school || "",
        province: r.province || "",
        grade: r.grade || "",
        sessions: Array.isArray(r.sessions) ? r.sessions.slice(-40) : [],
        sessionCount: Array.isArray(r.sessions) ? r.sessions.length : 0,
        lastScore: r.lastScore || null,
        lastSubject: r.lastSubject || "",
        lastType: r.lastType || "",
        updatedAt: r.updatedAt || null,
        createdAt: r.createdAt || null
      }));
    },
    "activity.delete": async (b) => {
      const id = S(b.id, 80);
      need(id, "معرّف مطلوب");
      await (await col("st_activity")).deleteOne({ _id: id });
      return { ok: true };
    },
    "activity.clear": async () => {
      await (await col("st_activity")).deleteMany({});
      return { ok: true };
    },
    "chat.users": async () =>
      (await (await col("st_chat_users")).find({}).sort({ createdAt: -1 }).limit(500).toArray()).map((u) => ({
        username: u.username,
        display: u.display || u.username,
        grade: u.grade || "",
        province: u.province || "",
        verified: !!u.verified,
        createdAt: u.createdAt || null
      })),
    "chat.deleteUser": async (b) => {
      const username = String(b.username || "").trim().toLowerCase();
      need(username, "يوزر مطلوب");
      await (await col("st_chat_users")).deleteOne({ username });
      return { ok: true };
    },
    "chat.verify": async (b) => {
      const username = String(b.username || "").trim().toLowerCase();
      need(username, "يوزر مطلوب");
      const verified = b.verified !== false;
      await (await col("st_chat_users")).updateOne({ username }, { $set: { verified } });
      return { ok: true, username, verified };
    }
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

  // ===================== تجاربي: حل المسائل على السبورة بالذكاء الاصطناعي =====================
  app.post("/api/study/experiment/solve", async (req, res) => {
    const ip = req.ip || "x";
    if (tooMany("experiment:" + ip, 8, 5 * 60 * 1000)) {
      return res.status(429).json({ error: "وصلت للحد المؤقت من المحاولات. انتظر قليلاً ثم جرّب مرة ثانية." });
    }
    try {
      const problem = S(req.body && req.body.problem, 5000);
      const subject = S(req.body && req.body.subject, 80);
      const grade = S(req.body && req.body.grade, 80);
      const image = String((req.body && req.body.image) || "");
      const imagePattern = /^data:image\/(?:jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/;
      need(problem.length >= 2 || imagePattern.test(image), "اكتب المسألة أو أرفق صورة واضحة لها.");
      if (image && !imagePattern.test(image)) throw bad("صيغة الصورة غير مدعومة. استخدم JPG أو PNG أو WEBP.");
      if (image.length > 1500000) throw bad("حجم الصورة كبير. اختر صورة أصغر أو التقط صورة جديدة.");

      const context = [
        "الصف الدراسي: " + (grade || "غير محدد"),
        "المادة: " + (subject || "حدد المادة من نص السؤال"),
        "المسألة المكتوبة: " + (problem || "اقرأ المسألة من الصورة المرفقة.")
      ].join("\n");
      const system = `أنت مدرس عراقي خبير يشرح لطلاب المدارس وفق مستوى الصف المحدد. مهمتك حل المسائل التعليمية بدقة وبأسلوب مبسّط.
أخرج JSON صالحاً فقط، بلا markdown ولا سياج كود، وبالمفاتيح التالية حصراً:
{"title":"عنوان قصير","problem":"نص المسألة كما فهمته","finalAnswer":"الجواب النهائي مع الوحدة إن وجدت","steps":[{"title":"اسم الخطوة","equation":"القانون أو العملية الحسابية","explanation":"شرح قصير وواضح بالعربية"}],"check":"طريقة تحقق مختصرة أو فارغ","tip":"ملاحظة تعليمية مفيدة أو فارغ","needsClarification":false}
قواعد الحل:
1) ابدأ بذكر المعطيات والمطلوب ضمن الخطوات إذا كان ذلك مناسباً، ثم اكتب القانون، ثم التعويض، ثم الحساب، ثم النتيجة.
2) اجعل كل خطوة قصيرة وقابلة للعرض منفردة على سبورة رقمية. استخدم رموزاً ومعادلات نصية واضحة، وتجنب LaTeX وعلامات markdown.
3) في الرياضيات لا تقفز على التحويلات الجبرية. في الفيزياء اذكر الوحدات والتحويلات. في الكيمياء اذكر الكتل المولية أو الموازنة عند الحاجة.
4) لا تخترع قيماً أو نصاً غير ظاهر في صورة السؤال. إذا كانت الصورة غير واضحة أو تنقصها معطيات لازمة، اجعل needsClarification=true واطلب صورة أوضح/معطيات إضافية في finalAnswer أو tip، ولا تخمّن النتيجة.
5) راعِ مستوى الطالب العراقي والصف المحدد، واشرح بالعربية السهلة. لا تدّعِ أن الإجابة مضمونة 100%.
6) اجعل steps بين 2 و10 خطوات، وfinalAnswer موجزاً وواضحاً.`;
      const userContent = image
        ? [{ type: "text", text: context }, { type: "image_url", image_url: { url: image } }]
        : context;
      const raw = await callAI([
        { role: "system", content: system },
        { role: "user", content: userContent }
      ], 2200);

      let parsed = null;
      const clean = String(raw || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
      try { parsed = JSON.parse(clean); } catch (_) {
        const match = clean.match(/\{[\s\S]*\}/);
        if (match) { try { parsed = JSON.parse(match[0]); } catch (_) {} }
      }
      // Fallback for providers that return explanatory text rather than strict JSON.
      if (!parsed || typeof parsed !== "object") {
        const lines = clean.split(/\r?\n/).map(x => x.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).filter(Boolean).slice(0, 10);
        parsed = {
          title: "شرح المسألة",
          problem: problem || "مسألة من صورة",
          finalAnswer: lines.length ? lines[lines.length - 1] : clean.slice(-500),
          steps: (lines.length ? lines : [clean]).map((line, i) => ({ title: "الخطوة " + (i + 1), equation: line.slice(0, 500), explanation: "" })),
          check: "",
          tip: "راجع الوحدات والمعطيات مع كتابك الدراسي.",
          needsClarification: false
        };
      }
      const steps = (Array.isArray(parsed.steps) ? parsed.steps : []).slice(0, 10).map((st, i) => ({
        title: S(st && st.title, 100) || ("الخطوة " + (i + 1)),
        equation: S(st && st.equation, 500),
        explanation: S(st && st.explanation, 600)
      }));
      if (!steps.length) throw bad("لم أستطع استخراج خطوات واضحة. أعد كتابة المسألة بصورة أبسط.", 502);
      res.set("Cache-Control", "no-store");
      res.json({
        ok: true,
        solution: {
          title: S(parsed.title, 120) || "حل المسألة",
          problem: S(parsed.problem, 1200) || problem || "مسألة من صورة",
          finalAnswer: S(parsed.finalAnswer, 700) || "راجع الخطوات أعلاه.",
          steps,
          check: S(parsed.check, 500),
          tip: S(parsed.tip, 500),
          needsClarification: !!parsed.needsClarification
        }
      });
    } catch (e) { fail(res, e); }
  });

  // جلب أسئلة الامتحان الورقي من قاعدة البيانات (يضيفها الأدمن)
  // للطالب نرجع نص الأسئلة فقط بدون الأجوبة
  app.post("/api/study/paper/generate", async (req, res) => {
    if (tooMany("pg" + (req.ip || "x"), 20, 600000)) return res.sendStatus(429);
    try {
      const grade = S(req.body && req.body.grade, 80);
      const subject = S(req.body && req.body.subject, 80);
      need(grade && subject, "الصف والمادة مطلوبان");

      const doc = await (await col("st_paper")).findOne({ grade, subject });
      need(doc && Array.isArray(doc.questions) && doc.questions.length >= 3,
        "لا يوجد امتحان ورقي لهذه المادة بعد. أضفه من صفحة الإدارة.");

      const questions = doc.questions.map((item) => {
        if (item && typeof item === "object") return String(item.q || "").trim();
        return String(item || "").trim();
      }).filter(Boolean).slice(0, 20);
      need(questions.length >= 3, "لا يوجد امتحان ورقي لهذه المادة بعد. أضفه من صفحة الإدارة.");

      res.json({
        grade,
        subject,
        questions,
        createdAt: Date.now()
      });
    } catch (e) { fail(res, e); }
  });

  // تصحيح الامتحان الورقي من صورة — يعتمد على الجواب الرسمي من الأدمن
  app.post("/api/study/paper/grade", async (req, res) => {
    if (tooMany("pr" + (req.ip || "x"), 6, 600000)) return res.sendStatus(429);
    try {
      const grade = S(req.body && req.body.grade, 80);
      const subject = S(req.body && req.body.subject, 80);
      const imgRe = /^data:image\/(jpeg|jpg|png|webp);base64,/;
      let images = [];
      if (Array.isArray(req.body && req.body.images)) {
        images = req.body.images.map((x) => String(x || "")).filter((x) => imgRe.test(x)).slice(0, 5);
      }
      if (!images.length && req.body && req.body.image) {
        const one = String(req.body.image || "");
        if (imgRe.test(one)) images = [one];
      }

      need(grade && subject, "الصف والمادة مطلوبان");
      need(images.length, "أضف صورة واحدة على الأقل");

      const doc = await (await col("st_paper")).findOne({ grade, subject });
      need(doc && Array.isArray(doc.questions) && doc.questions.length >= 3, "لا يوجد امتحان ورقي لهذه المادة");

      const items = doc.questions.map((item) => {
        if (item && typeof item === "object") {
          return { q: String(item.q || "").trim(), a: String(item.a || "").trim() };
        }
        return { q: String(item || "").trim(), a: "" };
      }).filter((x) => x.q).slice(0, 20);

      need(items.length >= 3, "الأسئلة ناقصة");
      need(items.every((x) => x.a), "أجوبة النموذج غير مكتملة في الإدارة");

      const qList = items.map((x, i) => `${i + 1}. السؤال: ${x.q}\n   الجواب النموذجي: ${x.a}`).join("\n");
      const totalQ = items.length;

      const system = `أنت مصحح امتحانات عراقي حازم ودقيق.
المادة الحالية: ${subject}
مهمتك: تصحيح ورقة الطالب سؤالاً بسؤال اعتماداً على الجواب النموذجي فقط.

قواعد إلزامية:
1) اقرأ من الصورة ما كتبه الطالب لكل سؤال (رقم السؤال مهم).
2) قارن إجابة الطالب مع «الجواب النموذجي» لهذا السؤال نفسه فقط.
3) ok=true فقط إذا إجابة الطالب تتحدث عن نفس موضوع السؤال ونفس معنى الجواب النموذجي (أو مرادف/اختصار لنفس المعنى).
4) ok=false فوراً إذا:
   - الجواب فارغ أو غير مقروء
   - الجواب من مادة أخرى أو موضوع مختلف (مثال: سؤال فيزياء عن المكثف وجواب عن الخلية/بروتين/أحياء)
   - الجواب لا يجيب على المطلوب حتى لو جملة صحيحة علمياً في سياق آخر
   - الجواب خطأ جوهري مقارنة بالنموذج
5) الاختصار مقبول فقط إذا بقي المعنى الأساسي لنفس السؤال (مثال: نموذج "وظيفة الرايبوسومات صنع البروتين" والطالب كتب "صنع البروتين" لنفس سؤال الرايبوسومات = صح).
6) لا تعطِ صح مجاملة. لا تفترض أن الورقة صحيحة. دقّق كل سؤال لوحده.
7) الدرجة من ${totalQ}. details عنصر واحد لكل سؤال 1..${totalQ}.

أرجع JSON فقط:
{
  "score": 2,
  "total": ${totalQ},
  "percent": 20,
  "summary": "ملخص صادق عن مستوى الإجابات",
  "details": [
    {"n":1,"ok":true,"student":"ما قرأته","note":"إجابة صحيحة"},
    {"n":2,"ok":false,"student":"صنع البروتين","note":"غير متعلقة بالسؤال. هذا موضوع أحياء. الصحيح: ..."},
    {"n":3,"ok":false,"student":"...","note":"إجابة خاطئة. الصحيح: ..."}
  ]
}`;

      const userContent = [
        { type: "text", text: `الصف: ${grade}\nالمادة: ${subject}\nعدد الأسئلة: ${totalQ}\nعدد الصور: ${images.length}\n\nالأسئلة مع الأجوبة النموذجية (مرجع التصحيح الوحيد):\n${qList}\n\nصحّح من الصور بدقة صارمة. أي جواب لا يطابق معنى الجواب النموذجي لنفس السؤال = خطأ، حتى لو كان صحيحاً في مادة أخرى. الاختصار مقبول فقط لنفس المعنى. أرجع JSON لكل الأسئلة 1..${totalQ}.` }
      ];
      for (const img of images) {
        userContent.push({ type: "image_url", image_url: { url: img, detail: "high" } });
      }

      const content = await callAI([
        { role: "system", content: system },
        { role: "user", content: userContent }
      ], 5000);

      let result;
      try {
        const cleaned = content.replace(/```json|```/g, "").trim();
        result = JSON.parse(cleaned);
      } catch (e) {
        throw bad("تعذر قراءة نتيجة التصحيح، حاول بصورة أوضح.");
      }

      const total = totalQ;
      const details = (Array.isArray(result.details) ? result.details : []).slice(0, 20).map((d) => ({
        n: Number(d.n) || 0,
        ok: !!d.ok,
        student: String(d.student || "").slice(0, 400),
        note: String(d.note || "").slice(0, 300)
      }));
      // تأكد من وجود تفصيل لكل سؤال
      if (details.length < total) {
        for (let i = 1; i <= total; i++) {
          if (!details.some((d) => d.n === i)) {
            details.push({ n: i, ok: false, student: "", note: "تعذر قراءة إجابة هذا السؤال من الورقة" });
          }
        }
        details.sort((a, b) => a.n - b.n);
      }

      let score = details.length
        ? details.filter((d) => d.ok).length
        : Number(result.score) || 0;
      score = Math.max(0, Math.min(total, Math.round(score)));
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

  // ===================== كروب الطلاب =====================
  function cleanUser(u) {
    return String(u || "").trim().toLowerCase().replace(/\s+/g, "_").slice(0, 20);
  }
  function validUser(u) {
    return /^[a-z0-9_\u0600-\u06ff]{3,20}$/i.test(u);
  }

  // تسجيل يوزر فريد لكروب الصف
  app.post("/api/study/chat/register", async (req, res) => {
    if (tooMany("chu" + (req.ip || "x"), 20, 600000)) return res.sendStatus(429);
    try {
      const b = req.body || {};
      const username = cleanUser(b.username);
      const display = S(b.name || b.display, 40) || username;
      const grade = S(b.grade, 80);
      const province = S(b.province, 40);
      const vid = S(b.vid, 64);
      need(validUser(username), "اليوزر 3–20 حرف/رقم بدون مسافات");
      need(grade, "اختر الصف");

      const c = await col("st_chat_users");
      const exists = await c.findOne({ username });
      if (exists) throw bad("هذا اليوزر مستخدم، اختر يوزر ثاني");

      const verifiedUsers = new Set(
        String(process.env.CHAT_VERIFIED || "aaa")
          .split(",")
          .map((x) => x.trim().toLowerCase())
          .filter(Boolean)
      );
      const verified = verifiedUsers.has(username);
      await c.insertOne({
        _id: username,
        username,
        display,
        grade,
        province,
        vid,
        verified,
        createdAt: Date.now()
      });
      res.json({ ok: true, username, display, grade, verified });
    } catch (e) { fail(res, e); }
  });

  // التحقق من توفر اليوزر
  app.post("/api/study/chat/check", async (req, res) => {
    if (tooMany("chk" + (req.ip || "x"), 60, 600000)) return res.sendStatus(429);
    try {
      const username = cleanUser(req.body && req.body.username);
      if (!validUser(username)) return res.json({ ok: false, available: false, error: "يوزر غير صالح" });
      const exists = await (await col("st_chat_users")).findOne({ username });
      res.json({ ok: true, available: !exists });
    } catch (e) { fail(res, e); }
  });

  // جلب رسائل كروب الصف
  app.post("/api/study/chat/messages", async (req, res) => {
    if (tooMany("chm" + (req.ip || "x"), 120, 600000)) return res.sendStatus(429);
    try {
      const grade = S(req.body && req.body.grade, 80);
      const after = Number(req.body && req.body.after) || 0;
      need(grade, "الصف مطلوب");
      const q = { grade };
      if (after) q.t = { $gt: after };
      const list = await (await col("st_chat_msgs")).find(q).sort({ t: -1 }).limit(80).toArray();
      list.reverse();
      const users = await (await col("st_chat_users")).find({
        username: { $in: [...new Set(list.map((m) => m.user))] }
      }).toArray();
      const vmap = {};
      users.forEach((u) => { vmap[u.username] = !!u.verified; });
      // حسابات موثّقة من الإعدادات حتى لو السجل قديم
      const verifiedUsers = new Set(
        String(process.env.CHAT_VERIFIED || "aaa")
          .split(",")
          .map((x) => x.trim().toLowerCase())
          .filter(Boolean)
      );
      res.json({
        messages: list.map((m) => ({
          id: String(m._id),
          user: m.user,
          display: m.display || m.user,
          text: m.text,
          t: m.t,
          verified: !!(vmap[m.user] || verifiedUsers.has(String(m.user || "").toLowerCase()))
        }))
      });
    } catch (e) { fail(res, e); }
  });

  // إرسال رسالة لكروب الصف
  app.post("/api/study/chat/send", async (req, res) => {
    if (tooMany("chs" + (req.ip || "x"), 40, 600000)) return res.sendStatus(429);
    try {
      const b = req.body || {};
      const username = cleanUser(b.username);
      const text = S(b.text, 400);
      need(validUser(username), "يوزر غير صالح");
      need(text, "اكتب رسالة");

      const user = await (await col("st_chat_users")).findOne({ username });
      need(user, "سجّل يوزر أولاً");
      const grade = user.grade;

      const doc = {
        grade,
        user: username,
        display: user.display || username,
        text,
        t: Date.now()
      };
      const verifiedUsers = new Set(
        String(process.env.CHAT_VERIFIED || "aaa")
          .split(",")
          .map((x) => x.trim().toLowerCase())
          .filter(Boolean)
      );
      const verified = !!(user.verified || verifiedUsers.has(username));
      // تحديث توثيق الحساب القديم إن لزم
      if (verified && !user.verified) {
        await (await col("st_chat_users")).updateOne({ username }, { $set: { verified: true } });
      }
      const r = await (await col("st_chat_msgs")).insertOne(doc);
      res.json({
        ok: true,
        message: { id: String(r.insertedId), user: doc.user, display: doc.display, text: doc.text, t: doc.t, verified }
      });
    } catch (e) { fail(res, e); }
  });

  // حذف رسالة (صاحب الرسالة فقط)
  app.post("/api/study/chat/delete", async (req, res) => {
    if (tooMany("chd" + (req.ip || "x"), 40, 600000)) return res.sendStatus(429);
    try {
      const b = req.body || {};
      const username = cleanUser(b.username);
      const id = S(b.id, 40);
      need(validUser(username), "يوزر غير صالح");
      need(id, "معرّف الرسالة مطلوب");
      const { ObjectId } = require("mongodb");
      if (!ObjectId.isValid(id)) throw bad("معرّف غير صالح");
      const c = await col("st_chat_msgs");
      const msg = await c.findOne({ _id: new ObjectId(id) });
      need(msg, "الرسالة غير موجودة");
      need(msg.user === username, "تقدر تحذف رسائلك فقط");
      await c.deleteOne({ _id: new ObjectId(id) });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // عدد الأعضاء في الصف
  app.post("/api/study/chat/info", async (req, res) => {
    if (tooMany("chi" + (req.ip || "x"), 60, 600000)) return res.sendStatus(429);
    try {
      const grade = S(req.body && req.body.grade, 80);
      need(grade, "الصف مطلوب");
      const members = await (await col("st_chat_users")).countDocuments({ grade });
      res.json({ grade, members });
    } catch (e) { fail(res, e); }
  });

  // ===================== التحديات ولوحة المتصدرين =====================
  app.post("/api/study/challenge/score", async (req, res) => {
    if (tooMany("chs" + (req.ip || "x"), 60, 600000)) return res.sendStatus(429);
    try {
      const b = req.body || {};
      const vid = S(b.vid, 64) || ("v_" + (req.ip || "x"));
      const name = S(b.name, 40) || "طالب";
      const grade = S(b.grade, 80) || "";
      const add = Math.max(0, Math.min(500, Number(b.add) || 0));
      const c = await col("st_challenge");
      const prev = await c.findOne({ _id: vid });
      const points = (prev && prev.points ? Number(prev.points) : 0) + add;
      await c.updateOne(
        { _id: vid },
        { $set: { name, grade, points, updatedAt: Date.now() }, $setOnInsert: { createdAt: Date.now() } },
        { upsert: true }
      );
      res.json({ ok: true, points });
    } catch (e) { fail(res, e); }
  });

  app.get("/api/study/challenge/leaders", async (req, res) => {
    if (tooMany("chl" + (req.ip || "x"), 80, 600000)) return res.sendStatus(429);
    try {
      const list = await (await col("st_challenge")).find({}).sort({ points: -1, updatedAt: 1 }).limit(30).toArray();
      res.json({
        leaders: list.map((x, i) => ({
          rank: i + 1,
          name: x.name || "طالب",
          grade: x.grade || "",
          points: Number(x.points) || 0
        }))
      });
    } catch (e) { fail(res, e); }
  });

  // مزامنة ملف الطالب ونشاطه من المنصة الدراسية
  app.post("/api/study/activity/sync", async (req, res) => {
    if (tooMany("act" + (req.ip || "x"), 40, 600000)) return res.sendStatus(429);
    try {
      const b = req.body || {};
      let vid = S(b.vid, 64);
      if (!vid || vid.length < 8) {
        vid = require("crypto").randomBytes(12).toString("hex");
      }
      const name = S(b.name, 40);
      const school = S(b.school, 100);
      const province = S(b.province, 40); // حقل قديم محفوظ للتوافق مع السجلات السابقة
      const grade = S(b.grade, 80);
      need(name, "الاسم مطلوب");
      need(school, "اسم المدرسة مطلوب");
      need(grade, "الصف مطلوب");

      const sessionsIn = Array.isArray(b.sessions) ? b.sessions : [];
      const mapped = sessionsIn.slice(0, 20).map((s) => ({
        t: Number(s.t) || Date.now(),
        type: S(s.type, 20) || "study",
        subject: S(s.subject, 80),
        score: Math.max(0, Math.min(100, Number(s.score) || 0)),
        total: Math.max(0, Math.min(100, Number(s.total) || 0)),
        percent: Math.max(0, Math.min(100, Number(s.percent) || 0)),
        extra: S(s.extra, 120),
        details: Array.isArray(s.details) ? s.details.slice(0, 20).map((d) => ({
          n: Number(d.n) || 0,
          ok: !!d.ok,
          q: S(d.q, 200),
          note: S(d.note, 200)
        })) : []
      }));

      const c = await col("st_activity");
      const prev = await c.findOne({ _id: vid });
      let sessions = Array.isArray(prev && prev.sessions) ? prev.sessions.slice() : [];
      // دمج الجلسات الجديدة بدون تكرار تقريبي (نفس الوقت تقريباً)
      mapped.forEach((s) => {
        const dup = sessions.some((x) => Math.abs((x.t || 0) - s.t) < 5000 && x.type === s.type && x.subject === s.subject);
        if (!dup) sessions.push(s);
      });
      sessions = sessions.sort((a, b) => (a.t || 0) - (b.t || 0)).slice(-80);
      const last = sessions.length ? sessions[sessions.length - 1] : null;

      await c.updateOne(
        { _id: vid },
        {
          $set: {
            name,
            school,
            province,
            grade,
            sessions,
            lastScore: last ? last.percent : null,
            lastSubject: last ? last.subject : "",
            lastType: last ? last.type : "",
            updatedAt: Date.now()
          },
          $setOnInsert: { createdAt: Date.now() }
        },
        { upsert: true }
      );
      res.json({ ok: true, vid });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/study/admin", async (req, res) => {
    if (!adminOK(req, res)) return;
    const h = Object.prototype.hasOwnProperty.call(A, req.body && req.body.action) ? A[req.body.action] : null;
    if (!h) return res.sendStatus(400);
    try { res.json(await h(req.body || {})); } catch (e) { fail(res, e); }
  });
};
 
 
 
