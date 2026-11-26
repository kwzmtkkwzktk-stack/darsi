// واجهة المنصة الدراسية: الطلاب والنتائج والملازم والمحاضرات وأسئلة الامتحانات والإعلانات
const { ObjectId, Binary } = require("mongodb");
const PHYSICS_PAPER_BANK = require("./public/physics-paper-exams.json");
const CHEMISTRY_SIXTH_BANK = require("./public/chemistry-sixth-scientific.json");

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

  // تطبيع الأسماء العربية ومقارنة الأخطاء الإملائية البسيطة
  const normArabicName = (value) => S(value, 140)
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/[ؤئ]/g, "ء")
    .replace(/ة/g, "ه").replace(/عبدالله/g, "عبد الله")
    .replace(/[^\u0600-\u06FF0-9]+/g, " ").replace(/\s+/g, " ").trim();

  function editDistance(a, b) {
    const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let diagonal = prev[0]; prev[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const old = prev[j];
        prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
        diagonal = old;
      }
    }
    return prev[b.length];
  }

  function arabicNameTokens(value) {
    return normArabicName(value).split(" ").filter(Boolean).flatMap(token => {
      if (token.startsWith("عبدال") && token.length > 5) return ["عبد", token.slice(3)];
      return [token];
    });
  }

  function nameMatchScore(query, fullName) {
    const q = arabicNameTokens(query);
    const n = arabicNameTokens(fullName);
    if (q.length < 2 || !n.length || q.length > n.length) return 0;

    // يجب أن تتطابق أجزاء الاسم بالترتيب نفسه. نسمح بخطأ حرف واحد
    // فقط في الكلمات الطويلة، بدلاً من مطابقة كلمات متفرقة من أسماء مختلفة.
    let cursor = 0, sum = 0;
    for (const token of q) {
      let found = -1, foundScore = 0;
      for (let i = cursor; i < n.length; i++) {
        const candidate = n[i];
        if (token === candidate) { found = i; foundScore = 1; break; }
        if (Math.min(token.length, candidate.length) >= 5 && Math.abs(token.length - candidate.length) <= 1 && editDistance(token, candidate) === 1) {
          if (found < 0) { found = i; foundScore = 0.88; }
        }
      }
      if (found < 0) return 0;
      cursor = found + 1;
      sum += foundScore;
    }
    return sum / q.length;
  }

  const htmlText = (value) => String(value || "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#039;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ").trim();

  const ADMISSIONS_SOURCES = [
    { url: "https://graduation.uobaghdad.edu.iq/?p=29496", batch: "الوجبة الأولى" },
    { url: "https://graduation.uobaghdad.edu.iq/?p=31267", batch: "الوجبة الثانية" }
  ];
  let admissionsCache = { at: 0, rows: [] };
  async function getEveningAdmissions() {
    if (admissionsCache.rows.length && Date.now() - admissionsCache.at < 15 * 60 * 1000) return admissionsCache.rows;
    if (typeof fetch !== "function") throw bad("خدمة البحث عن نتائج القبول غير متاحة حالياً", 503);
    const allRows = [];
    for (const source of ADMISSIONS_SOURCES) {
      const response = await fetch(source.url, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; DarsiStudentLookup/1.0)", "accept": "text/html" },
        signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) throw bad("تعذر الوصول إلى إحدى صفحات نتائج الجامعة حالياً", 502);
      const html = await response.text();
      const tables = html.match(/<table\b[\s\S]*?<\/table>/gi) || [];
      const table = tables.find(t => /اسم\s*الطالب/.test(htmlText(t)) && /الكليه|الكلية/.test(htmlText(t)) && /القسم/.test(htmlText(t)));
      if (!table) throw bad("تغير تنسيق إحدى صفحات نتائج الجامعة، تعذر قراءة القائمة", 502);
      const trs = table.match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
      let pageRows = 0;
      for (const tr of trs) {
        const rawCells = [...tr.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => htmlText(m[1]));
        if (rawCells.length < 3) continue;
        const hasSerial = /^\d+$/.test(rawCells[0]);
        const name = rawCells[hasSerial ? 1 : 0] || "";
        const college = rawCells[hasSerial ? 2 : 1] || "";
        const department = rawCells[hasSerial ? 3 : 2] || "";
        if (normArabicName(name).split(" ").length >= 2 && college && department && !/اسم الطالب/.test(name)) {
          allRows.push({ name, college, department, batch: source.batch });
          pageRows++;
        }
      }
      if (pageRows < 50) throw bad("لم تكتمل قراءة إحدى قوائم نتائج الجامعة، أعد المحاولة لاحقاً", 502);
    }
    admissionsCache = { at: Date.now(), rows: allRows };
    return allRows;
  }

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

  const fileOut = (f) => ({ id: String(f._id), title: f.title, subject: f.subject || "", grade: f.grade || "", name: f.name, type: f.type, size: f.size || 0, url: f.url || "", source: f.source || "file", date: f.date });

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
      const suppliedName = S(req.body && req.body.name, 120);
      if (code.length < 4) return res.sendStatus(404);
      const d = await (await col("st_students")).findOne({ _id: code });
      if (!d) return res.sendStatus(404);
      if (!S(d.n, 120) && !suppliedName) return res.status(409).json({ error: "اكتب اسمك حتى نكمل التحقق من الحساب" });
      if (suppliedName && d.n && nameMatchScore(suppliedName, d.n) < 0.82) return res.status(403).json({ error: "الاسم لا يطابق الاسم المسجل لهذا الرمز" });
      res.set("Cache-Control", "no-store");
      res.json({ n: d.n || suppliedName, g: d.g, department: d.department, stage: d.stage, x: d.x || {}, ab: d.ab || [] });
    } catch (e) { fail(res, e); }
  });

  // البحث بالاسم في قائمة القبول المسائي المنشورة من جامعة بغداد
  app.post("/api/study/admissions/search", async (req, res) => {
    if (tooMany("admission" + (req.ip || "x"), 20, 600000)) return res.sendStatus(429);
    try {
      const name = S(req.body && req.body.name, 120);
      const tokens = normArabicName(name).split(" ").filter(Boolean);
      need(tokens.length >= 2, "اكتب اسمك الثنائي أو الثلاثي على الأقل");
      need(tokens.length <= 7, "الاسم طويل جداً، اكتب الاسم الثنائي أو الثلاثي");
      const rows = await getEveningAdmissions();
      const matches = rows.map(row => ({ ...row, score: nameMatchScore(name, row.name) }))
        .filter(row => row.score >= 0.90)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)
        .map(({ score, ...row }) => ({ ...row, confidence: Math.round(score * 100) }));
      res.set("Cache-Control", "no-store");
      res.json({ ok: true, matches, source: ADMISSIONS_SOURCES[0].url, sources: ADMISSIONS_SOURCES, updatedAt: admissionsCache.at, total: rows.length });
    } catch (e) { fail(res, e); }
  });

  // =============== استفسارات الطلاب والردود الخاصة ===============
  // يعتمد التحقق على رمز الطالب فقط، وتُؤخذ بياناته من قاعدة البيانات
  app.post("/api/study/inquiries", async (req, res) => {
    if (tooMany("inq" + (req.ip || "x"), 20, 600000)) return res.sendStatus(429);
    try {
      const b = req.body || {}, code = S(b.code, 20).replace(/\D/g, "");
      const message = S(b.message, 2000);
      need(code.length >= 4 && message.length >= 5, "اكتب الاستفسار بشكل أوضح");
      const student = await (await col("st_students")).findOne({ _id: code });
      if (!student) return res.sendStatus(404);
      const now = Date.now();
      const doc = { code, name: student.n, department: student.department || "", stage: student.stage || "", message, reply: "", createdAt: now, repliedAt: 0, seenAt: 0 };
      const result = await (await col("st_inquiries")).insertOne(doc);
      res.set("Cache-Control", "no-store"); res.json({ ok: true, id: String(result.insertedId) });
    } catch (e) { fail(res, e); }
  });
  app.get("/api/study/inquiries", async (req, res) => {
    try {
      const code = S(req.query.code, 20).replace(/\D/g, "");
      if (code.length < 4) return res.sendStatus(404);
      const student = await (await col("st_students")).findOne({ _id: code });
      if (!student) return res.sendStatus(404);
      const list = await (await col("st_inquiries")).find({ code }).sort({ createdAt: -1 }).limit(50).toArray();
      res.set("Cache-Control", "no-store");
      res.json(list.map(x => ({ id: String(x._id), message: x.message, reply: x.reply || "", createdAt: x.createdAt, repliedAt: x.repliedAt || 0, seenAt: x.seenAt || 0 })));
    } catch (e) { fail(res, e); }
  });
  app.post("/api/study/inquiries/seen", async (req, res) => {
    try {
      const b=req.body||{}, code=S(b.code,20).replace(/\D/g,""), id=oid(b.id);
      if (!id || code.length < 4) return res.sendStatus(404);
      const student=await (await col("st_students")).findOne({_id:code});
      if(!student) return res.sendStatus(404);
      await (await col("st_inquiries")).updateOne({ _id:id, code, reply:{ $ne:"" } }, { $set:{ seenAt:Date.now() } });
      res.json({ ok:true });
    } catch(e){ fail(res,e); }
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
      (await (await col("st_students")).find({}).sort({ n: 1 }).limit(3000).toArray()).map((s) => ({ code: s._id, n: s.n, g: s.g, department: s.department || "", stage: s.stage || "", x: s.x || {}, ab: s.ab || [] })),

    "students.save": async (b) => {
      const st = await settings();
      const n = S(b.n, 120).replace(/\s+/g, " ").trim();
      need(n.split(" ").filter(Boolean).length >= 3, "اكتب الاسم الثلاثي للطالب");
      const department = S(b.department, 40);
      const stage = S(b.stage, 20);
      need(["الكيمياء", "الفيزياء", "الرياضيات", "الأحياء", "الحاسوب"].includes(department), "اختر القسم");
      need(["مرحلة 1", "مرحلة 2", "مرحلة 3", "مرحلة 4"].includes(stage), "اختر المرحلة");
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
      else {
        need(code.length >= 6, "الرمز قصير (6 أرقام على الأقل)");
        const existing = await c.findOne({ _id: code });
        if (b.editing) need(!!existing, "لم يتم العثور على الطالب لتعديل بياناته");
        else need(!existing, "هذا الرمز مستخدم لطالب آخر، اختر رمزاً مختلفاً");
      }
      await c.updateOne({ _id: code }, { $set: { n, g, department, stage, x, ab, updatedAt: new Date() } }, { upsert: true });
      return { ok: true, code };
    },

    "students.bulk": async (b) => {
      const st = await settings();
      const g = S(b.g, 80);
      need(st.grades[g], "اختر الصف");
      const department = S(b.department, 40);
      const stage = S(b.stage, 20);
      need(["الكيمياء", "الفيزياء", "الرياضيات", "الأحياء", "الحاسوب"].includes(department), "اختر القسم");
      need(["مرحلة 1", "مرحلة 2", "مرحلة 3", "مرحلة 4"].includes(stage), "اختر المرحلة");
      const names = (Array.isArray(b.names) ? b.names : []).map((x) => S(x, 120).replace(/\s+/g, " ").trim()).filter((x) => x.split(" ").length >= 3).slice(0, 500);
      need(names.length, "اكتب الأسماء الثلاثية للطلاب، اسماً في كل سطر");
      need(names.length, "اكتب اسماً واحداً على الأقل");
      const c = await col("st_students");
      const out = [];
      for (const n of names) {
        const code = await newCode(c);
        await c.insertOne({ _id: code, n, g, department, stage, x: {}, ab: [], updatedAt: new Date() });
        out.push({ code, n });
      }
      return { ok: true, list: out };
    },

    "students.delete": async (b) => {
      await (await col("st_students")).deleteOne({ _id: S(b.code, 20) });
      return { ok: true };
    },

    "inquiries.list": async () => (await (await col("st_inquiries")).find({}).sort({ createdAt: -1 }).limit(500).toArray()).map(x => ({ id:String(x._id), code:x.code, name:x.name, department:x.department, stage:x.stage, message:x.message, reply:x.reply||"", createdAt:x.createdAt, repliedAt:x.repliedAt||0 })),
    "inquiries.reply": async (b) => {
      const _id=oid(b.id), reply=S(b.reply,2000);
      need(_id && reply.length >= 2, "اكتب الرد بشكل صحيح");
      const r=await (await col("st_inquiries")).updateOne({ _id }, { $set:{ reply, repliedAt:Date.now(), seenAt:0 } });
      need(r.matchedCount, "لم يتم العثور على الاستفسار");
      return { ok:true };
    },

    "files.list": async () => (await (await col("st_files")).find({}).sort({ date: -1 }).limit(500).toArray()).map(fileOut),
    "files.link.save": async (b) => {
      const title = S(b.title, 200);
      const url = S(b.url, 1000);
      need(title, "عنوان الملزمة مطلوب");
      need(/^https?:\/\//i.test(url), "الرابط يجب أن يبدأ بـ https:// أو http://");
      let parsed;
      try { parsed = new URL(url); } catch (_) { throw bad("الرابط غير صحيح"); }
      need(["http:", "https:"].includes(parsed.protocol), "نوع الرابط غير مسموح");
      const st = await settings();
      const grade = S(b.grade, 80);
      need(!grade || st.grades[grade], "الصف غير صحيح");
      const id = new ObjectId();
      await (await col("st_files")).insertOne({
        _id: id, title, subject: S(b.subject, 80), grade,
        name: title, type: "link", source: "link", url,
        size: 0, date: new Date()
      });
      return { ok: true, id: String(id) };
    },
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
    // يمكن اختيار موديل ثابت من Render عبر OPENROUTER_MODEL؛ الافتراضي مجاني ومتعدد الوسائط.
    const model = process.env.OPENROUTER_MODEL || "openrouter/free";
    let r;
    try {
      r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + key,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "https://darsi.app",
          "X-Title": process.env.OPENROUTER_APP_NAME || "Darsi"
        },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.35 })
      });
    } catch (networkError) {
      console.error("OpenRouter network error:", networkError && networkError.message);
      throw bad("تعذر الوصول إلى OpenRouter. تحقق من اتصال الخادم وحاول مرة ثانية.", 502);
    }
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      console.error("OpenRouter error:", r.status, t.slice(0, 700));
      let detail = "تعذر تنفيذ طلب الذكاء الاصطناعي.";
      let parsed = {}; try { parsed = JSON.parse(t); } catch (_) {}
      const msg = String(parsed && parsed.error && (parsed.error.message || parsed.error.metadata && parsed.error.metadata.raw) || "").toLowerCase();
      if (r.status === 401 || r.status === 403) detail = "مفتاح OpenRouter غير صحيح أو لا يملك صلاحية الاستخدام. راجع OPENROUTER_API_KEY في Render.";
      else if (r.status === 402 || /credit|balance|payment|fund/.test(msg)) detail = "رصيد OpenRouter غير كافٍ لهذا الموديل. اختر موديل مجاني متاحاً أو راجع رصيد الحساب.";
      else if (r.status === 429) detail = "وصلت إلى حد الطلبات للموديل. انتظر قليلاً أو تحقق من حدود OpenRouter.";
      else if (r.status === 404 || /no endpoints|model.*not found/.test(msg)) detail = "الموديل المحدد غير متاح أو لا يدعم نوع الطلب. راجع OPENROUTER_MODEL.";
      else if (/image|vision|modality/.test(msg)) detail = "الموديل المحدد لا يدعم تحليل الصور. اختر موديلاً يقبل image ضمن input modalities.";
      throw bad(detail, r.status === 429 ? 429 : 502);
    }
    const j = await r.json();
    const message = j.choices && j.choices[0] && j.choices[0].message;
    const content = message && message.content;
    if (Array.isArray(content)) return content.map(x => x && (x.text || "")).join("").trim();
    return typeof content === "string" ? content : "";
  }

  // مدرس محادثة: لا نخزن سجل المحادثة أو الصور في قاعدة البيانات.
  app.post("/api/study/ai/chat", async (req, res) => {
    if (tooMany("ai-chat:" + (req.ip || "x"), 15, 5 * 60 * 1000)) {
      return res.status(429).json({ error: "وصلت للحد المؤقت من الأسئلة. انتظر قليلاً ثم حاول." });
    }
    try {
      const message = S(req.body && req.body.message, 3000);
      const grade = S(req.body && req.body.grade, 100);
      const subject = S(req.body && req.body.subject, 100);
      const history = Array.isArray(req.body && req.body.history) ? req.body.history.slice(-8) : [];
      need(message.length >= 2, "اكتب سؤالك حتى أقدر أساعدك.");
      const safeHistory = history.map(m => ({
        role: m && m.role === "assistant" ? "assistant" : "user",
        content: S(m && m.content, 1200)
      })).filter(m => m.content);
      const system = `أنت مدرس مساعد لمنصة دَرسي العراقية. اشرح للطالب بعربية واضحة ولهجة عراقية بيضاء خفيفة، وبمستوى الصف المحدد. المادة: ${subject || "غير محددة"}. الصف: ${grade || "غير محدد"}. ابدأ بالجواب مباشرة، ثم وضح الفكرة بخطوات قصيرة وأمثلة عند الحاجة. لا تخترع معلومات أو تنسب إجابة إلى كتاب وزاري دون نص موثوق. إذا كان السؤال ناقصاً اطلب توضيحاً. لا تطلب بيانات شخصية من الطالب. إذا كان الموضوع خارج الدراسة، أجب باختصار وأعد توجيهه للتعلم.`;
      const answer = await callAI([{ role: "system", content: system }, ...safeHistory, { role: "user", content: message }], 1200);
      need(answer && answer.trim().length > 1, "لم يصل رد من المدرس الذكي. حاول مرة ثانية.");
      res.set("Cache-Control", "no-store");
      res.json({ ok: true, answer: answer.trim().slice(0, 6000) });
    } catch (e) { fail(res, e); }
  });

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
      const system = `أنت مدرّسة عراقية خبيرة تشرح لطلاب المدارس وفق مستوى الصف المحدد. احچي باللهجة العراقية البيضاء الطبيعية وبأسلوب ودود ومشجّع، ومهمتك حل المسائل التعليمية بدقة وبأسلوب مبسّط.
أخرج JSON صالحاً فقط، بلا markdown ولا سياج كود، وبالمفاتيح التالية حصراً:
{"title":"عنوان قصير","problem":"نص المسألة كما فهمته","finalAnswer":"الجواب النهائي مع الوحدة إن وجدت","spokenScript":"خلاصة منطوقة قصيرة باللهجة العراقية","steps":[{"title":"اسم الخطوة","equation":"القانون أو العملية الحسابية","explanation":"شرح مكتوب واضح","spoken":"كلام قصير تحچي بيه المدرّسة باللهجة العراقية عن هاي الخطوة"}],"check":"طريقة تحقق مختصرة أو فارغ","tip":"ملاحظة تعليمية مفيدة أو فارغ","needsClarification":false}
قواعد الحل:
1) ابدأ بذكر المعطيات والمطلوب ضمن الخطوات إذا كان ذلك مناسباً، ثم اكتب القانون، ثم التعويض، ثم الحساب، ثم النتيجة.
2) اجعل كل خطوة قصيرة وقابلة للعرض منفردة على سبورة رقمية. استخدم رموزاً ومعادلات نصية واضحة، وتجنب LaTeX وعلامات markdown.
3) في الرياضيات لا تقفز على التحويلات الجبرية. في الفيزياء اذكر الوحدات والتحويلات. في الكيمياء اذكر الكتل المولية أو الموازنة عند الحاجة.
4) لا تخترع قيماً أو نصاً غير ظاهر في صورة السؤال. إذا كانت الصورة غير واضحة أو تنقصها معطيات لازمة، اجعل needsClarification=true واطلب صورة أوضح/معطيات إضافية في finalAnswer أو tip، ولا تخمّن النتيجة.
5) راعِ مستوى الطالب العراقي والصف المحدد، واشرح بالعربية السهلة. لكل خطوة أضيفي spoken: جملة أو جملتين باللهجة العراقية البيضاء الطبيعية، مثل (هسه، خلّينا، شوف، ننتبه)، وخليها سهلة النطق صوتياً بدون رموز معادلات معقدة. أضف spokenScript بخلاصة منطوقة من جملتين أو ثلاث باللهجة العراقية تشجع الطالب وتلخص النتيجة. لا تستخدم الفصحى الرسمية في الكلام المنطوق ولا تبالغ بالمفردات العامية. لا تدّعِ أن الإجابة مضمونة 100%.
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
        explanation: S(st && st.explanation, 600),
        spoken: S(st && st.spoken, 380) || S(st && st.explanation, 380) || S(st && st.title, 120)
      }));
      if (!steps.length) throw bad("لم أستطع استخراج خطوات واضحة. أعد كتابة المسألة بصورة أبسط.", 502);
      res.set("Cache-Control", "no-store");
      res.json({
        ok: true,
        solution: {
          title: S(parsed.title, 120) || "حل المسألة",
          problem: S(parsed.problem, 1200) || problem || "مسألة من صورة",
          finalAnswer: S(parsed.finalAnswer, 700) || "راجع الخطوات أعلاه.",
          spokenScript: S(parsed.spokenScript, 1200) || ("وهسه خلصنا الحل. النتيجة هي: " + (S(parsed.finalAnswer, 500) || "راجع النتيجة المكتوبة فوق") + ". عاشت إيدك، راجع الخطوات حتى تثبت المعلومة."),
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
      const requestedGrade = S(req.body && req.body.grade, 80);
      const requestedSubject = S(req.body && req.body.subject, 80);
      const groupKey = S(req.body && req.body.groupKey, 120);
      const imgRe = /^data:image\/(jpeg|jpg|png|webp);base64,/;
      let images = [];
      if (Array.isArray(req.body && req.body.images)) {
        images = req.body.images.map((x) => String(x || "")).filter((x) => imgRe.test(x)).slice(0, 5);
      }
      if (!images.length && req.body && req.body.image) {
        const one = String(req.body.image || "");
        if (imgRe.test(one)) images = [one];
      }

      need(images.length, "أضف صورة واحدة على الأقل");

      let grade = requestedGrade;
      let subject = requestedSubject;
      let items = [];
      let questionLimit = 20;
      if (groupKey) {
        const group = PHYSICS_PAPER_BANK.find((g) => String(g.key || "") === groupKey);
        need(group && Array.isArray(group.questions), "نموذج الفيزياء غير موجود");
        grade = String(group.grade || "السادس الإعدادي (علمي)");
        subject = String(group.subject || "الفيزياء");
        questionLimit = 30;
        items = group.questions.map((item) => ({
          q: String(item && item.q || "").trim(),
          a: String(item && item.a || "").trim()
        })).filter((x) => x.q).slice(0, questionLimit);
      } else {
        need(grade && subject, "الصف والمادة مطلوبان");
        const doc = await (await col("st_paper")).findOne({ grade, subject });
        need(doc && Array.isArray(doc.questions) && doc.questions.length >= 3, "لا يوجد امتحان ورقي لهذه المادة");
        items = doc.questions.map((item) => {
          if (item && typeof item === "object") {
            return { q: String(item.q || "").trim(), a: String(item.a || "").trim() };
          }
          return { q: String(item || "").trim(), a: "" };
        }).filter((x) => x.q).slice(0, questionLimit);
      }

      need(items.length >= 3, "الأسئلة ناقصة");
      need(items.every((x) => x.a), "أجوبة النموذج غير مكتملة");

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
      const details = (Array.isArray(result.details) ? result.details : []).slice(0, questionLimit).map((d) => {
        const n = Number(d.n) || 0;
        const ok = !!d.ok;
        const item = { n, ok, student: String(d.student || "").slice(0, 400) };
        item.note = ok ? "إجابة صحيحة" : "إجابة خاطئة";
        // إظهار الجواب النموذجي بعد التصحيح فقط، ولكل المواد الورقية
        if (!ok && n >= 1 && n <= items.length) item.correctAnswer = items[n - 1].a;
        return item;
      });
      // تأكد من وجود تفصيل لكل سؤال
      if (details.length < total) {
        for (let i = 1; i <= total; i++) {
          if (!details.some((d) => d.n === i)) {
            const missing = { n: i, ok: false, student: "", note: "تعذر قراءة إجابة هذا السؤال من الورقة" };
            if (items[i - 1] && items[i - 1].a) missing.correctAnswer = items[i - 1].a;
            details.push(missing);
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

  // تصحيح حلّ الطالب المكتوب بخط اليد لسؤال واحد، بالاعتماد على الجواب الأصلي من الخادم.
  app.post("/api/study/handwriting/grade", async (req, res) => {
    if (tooMany("hw" + (req.ip || "x"), 8, 600000)) return res.status(429).json({ error: "وصلت للحد المؤقت من محاولات التصحيح. حاول بعد قليل." });
    try {
      const image = String((req.body && req.body.image) || "");
      const imgRe = /^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/;
      need(imgRe.test(image), "صوّر الحل أو اختر صورة واضحة من المعرض.");
      need(image.length <= 1200000, "حجم الصورة كبير. اختر صورة أصغر أو التقط صورة جديدة.");

      let question = null;
      const groupKey = S(req.body && req.body.groupKey, 120);
      const chemistryGroupKey = S(req.body && req.body.chemistryGroupKey, 120);
      const questionIndex = Number(req.body && req.body.questionIndex);
      const questionId = S(req.body && req.body.questionId, 80);

      if (groupKey) {
        need(Number.isInteger(questionIndex) && questionIndex >= 0, "رقم السؤال غير صحيح.");
        const group = PHYSICS_PAPER_BANK.find((g) => String(g.key || "") === groupKey);
        need(group && Array.isArray(group.questions), "نموذج الفيزياء غير موجود.", 404);
        const item = group.questions[questionIndex];
        need(item && item.q && item.a, "السؤال أو جوابه النموذجي غير متوفر.", 404);
        question = {
          q: String(item.q), a: String(item.a),
          subject: String(group.subject || "الفيزياء"),
          grade: String(group.grade || "السادس الإعدادي (علمي)"),
          chapter: String(group.chapter || "")
        };
      } else if (chemistryGroupKey) {
        need(Number.isInteger(questionIndex) && questionIndex >= 0, "رقم السؤال غير صحيح.");
        const group = CHEMISTRY_SIXTH_BANK.find((g) => String(g.key || "") === chemistryGroupKey);
        need(group && Array.isArray(group.questions), "مجموعة أسئلة الكيمياء غير موجودة.", 404);
        const item = group.questions[questionIndex];
        need(item && item.q && item.a, "السؤال أو جوابه النموذجي غير متوفر.", 404);
        question = {
          q: String(item.q), a: String(item.a),
          subject: String(group.subject || "الكيمياء"),
          grade: String(group.grade || "السادس الإعدادي (علمي)"),
          chapter: String(group.chapter || "")
        };
      } else {
        const id = oid(questionId);
        need(id, "السؤال غير معروف. أعد فتح الاختبار وحاول مرة ثانية.", 404);
        const saved = await (await col("st_questions")).findOne({ _id: id });
        need(saved && saved.q && saved.a, "السؤال أو جوابه النموذجي غير موجود.", 404);
        question = {
          q: String(saved.q), a: String(saved.a),
          subject: String(saved.subject || ""), grade: String(saved.grade || ""),
          chapter: String(saved.chapter || "")
        };
      }

      const system = `أنت مصحح تربوي دقيق لدفاتر الطلاب العراقيين. ستصلك صورة لحل مكتوب بخط اليد لسؤال واحد، ومعها نص السؤال والجواب النموذجي من المنصة.
المطلوب أن تقرأ ما كتبه الطالب من الصورة، ثم تقارنه بالجواب النموذجي لهذا السؤال فقط.
قواعد مهمة:
- لا تخمّن أي كتابة غير واضحة، ولا تعتبر عدم وضوح الصورة خطأ؛ في هذه الحالة status="unclear".
- status="correct" فقط إذا كان الحل أو الجواب صحيحاً في المعنى والحساب، مع قبول الصياغة المكافئة والخطوات الصحيحة والوحدات المكافئة.
- status="incorrect" إذا كانت الإجابة مقروءة لكنها تخالف المطلوب أو تتضمن خطأ علمياً/حسابياً جوهرياً.
- في المسائل الحسابية افحص القانون والتعويض والحساب والوحدات بقدر ما تسمح به الصورة، ولا تعتمد على تطابق رقم نهائي وحده إذا كانت الخطوات خاطئة بوضوح.
- إذا كانت الصورة لا تحتوي حلاً للسؤال أو لا يمكن تمييز جواب الطالب، استخدم unclear.
- لا تضف معلومات إلى الجواب النموذجي، ولا تغيّره.
أخرج JSON صالحاً فقط دون markdown وبالمفاتيح التالية حصراً:
{"status":"correct|incorrect|unclear","studentAnswer":"ما تمكنت من قراءته من الورقة أو فارغ","feedback":"تعليق قصير باللهجة العراقية الواضحة، يوضح سبب النتيجة دون إطالة"}`;

      const userContent = [
        { type: "text", text: `الصف: ${question.grade}\nالمادة: ${question.subject}\nالفصل: ${question.chapter}\nالسؤال: ${question.q}\nالجواب النموذجي المعتمد: ${question.a}\n\nاقرأ حل الطالب من الصورة وصحّح هذا السؤال فقط. أرجع JSON حسب التعليمات.` },
        { type: "image_url", image_url: { url: image, detail: "high" } }
      ];
      const raw = String(await callAI([
        { role: "system", content: system },
        { role: "user", content: userContent }
      ], 900) || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

      let result;
      try {
        result = JSON.parse(raw);
      } catch (_) {
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) { try { result = JSON.parse(match[0]); } catch (_) {} }
      }
      if (!result || typeof result !== "object") throw bad("تعذر قراءة نتيجة التصحيح. أعد تصوير الحل بصورة أوضح.", 502);

      const allowed = ["correct", "incorrect", "unclear"];
      const status = allowed.includes(String(result.status || "").toLowerCase()) ? String(result.status).toLowerCase() : "unclear";
      res.set("Cache-Control", "no-store");
      res.json({
        ok: true,
        status,
        studentAnswer: S(result.studentAnswer, 700),
        feedback: S(result.feedback, 500) || (status === "correct" ? "إجابتك صحيحة، عاشت إيدك!" : status === "incorrect" ? "إجابتك تحتاج مراجعة." : "الصورة غير واضحة، جرّب تصويرها مرة ثانية."),
        modelAnswer: question.a
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
 
 
 
 
 
