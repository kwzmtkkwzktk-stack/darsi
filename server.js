
const express = require("express");
const path = require("path");
const { MongoClient, ObjectId, Binary } = require("mongodb");
const crypto = require("crypto");

const app = express();

// إعدادات الموقع — تم إصلاح الخطأ هنا
app.use(express.json({ limit: "15mb" }));
app.use(express.static(path.join(__dirname, "public")));

let client;
let dbPromise;

// الاتصال بقاعدة البيانات MongoDB
async function db() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is not configured");
  }

  if (!dbPromise) {
    client = new MongoClient(process.env.MONGODB_URI);

    dbPromise = client.connect()
      .then(() => client.db("darsi"))
      .catch(error => {
        dbPromise = null;
        client = null;
        throw error;
      });
  }

  return dbPromise;
}

// فحص اتصال الموقع وقاعدة البيانات
app.get("/api/health", async (req, res) => {
  try {
    const database = await db();
    await database.command({ ping: 1 });

    res.json({
      ok: true,
      database: "darsi",
      connected: true
    });
  } catch (error) {
    console.error("Health check failed:", error.message);

    res.status(503).json({
      ok: false,
      connected: false
    });
  }
});

// الصفحة الرئيسية
app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "study.html")
  );
});

// لوحات الإدارة
app.get("/admin", (req, res) => {
  res.redirect("/study-admin.html");
});
app.get("/site-editor", (req, res) => {
  res.redirect("/site-editor.html");
});

// جلب بيانات الطالب حسب الكود
app.get("/api/student", async (req, res) => {
  try {
    const code = String(req.query.code || "");

    if (!/^\d{4,12}$/.test(code)) {
      return res.sendStatus(404);
    }

    const student = await (await db())
      .collection("students")
      .findOne({ _id: code });

    res.set("Cache-Control", "no-store");

    if (!student) {
      return res.sendStatus(404);
    }

    res.json({
      n: student.n || "",
      g: student.g || "",
      x: student.x || {},
      ab: student.ab || []
    });

  } catch (error) {
    console.error("Student API error:", error.message);

    res.status(500).json({
      error: "حدث خطأ في الخادم"
    });
  }
});

// واجهة الإدارة
app.post("/api/admin", async (req, res) => {
  const body = req.body || {};

  // التحقق من رمز المدير
  if (
    !process.env.ADMIN_CODE ||
    String(body.pass || "") !== process.env.ADMIN_CODE
  ) {
    return res.sendStatus(401);
  }

  try {
    const collection = (await db()).collection("students");

    // التحقق من رمز المدير
    if (body.action === "check") {
      return res.json({ ok: true });
    }

    // إنشاء طالب جديد
    if (body.action === "create") {
      const name = String(body.n || "").trim();

      if (!name || name.length > 150) {
        return res.status(400).json({
          error: "اكتب اسم الطالب بصورة صحيحة"
        });
      }

      let code;
      let created = false;

      for (let attempt = 0; attempt < 10; attempt++) {
        code = String(
          crypto.randomInt(10000000, 100000000)
        );

        try {
          await collection.insertOne({
            _id: code,
            n: name,
            g: "",
            x: {},
            ab: [],
            createdAt: new Date()
          });

          created = true;
          break;

        } catch (error) {
          if (error.code !== 11000) {
            throw error;
          }
        }
      }

      if (!created) {
        throw new Error(
          "Could not generate a unique student code"
        );
      }

      return res.status(201).json({
        ok: true,
        student: {
          c: code,
          n: name
        }
      });
    }

    // عرض الطلاب
    if (body.action === "list") {
      const students = await collection
        .find({}, {
          projection: { n: 1 }
        })
        .sort({ n: 1 })
        .toArray();

      return res.json(
        students.map(student => ({
          c: student._id,
          n: student.n || ""
        }))
      );
    }

    // نشر درجات الطلاب
    if (body.action === "publish") {
      const items = Array.isArray(body.items)
        ? body.items
        : [];

      const operations = items
        .filter(item =>
          item &&
          /^\d{4,12}$/.test(String(item.c)) &&
          Number(item.e) >= 0 &&
          Number(item.e) <= 5 &&
          Array.isArray(item.m) &&
          item.m.every(row =>
            Array.isArray(row) &&
            row.length >= 2 &&
            Number.isFinite(Number(row[1]))
          )
        )
        .map(item => ({
          updateOne: {
            filter: {
              _id: String(item.c)
            },
            update: {
              $set: {
                n: String(item.n || ""),
                g: String(item.g || ""),
                ["x." + Number(item.e)]: item.m.map(
                  ([subject, value]) => [
                    String(subject),
                    Number(value)
                  ]
                )
              },
              $setOnInsert: {
                ab: [],
                createdAt: new Date()
              }
            },
            upsert: true
          }
        }));

      if (operations.length) {
        await collection.bulkWrite(operations);
      }

      return res.json({
        ok: true,
        n: operations.length
      });
    }

    // تسجيل غياب الطالب
    if (body.action === "absence") {
      const code = String(body.c || "");

      if (!/^\d{4,12}$/.test(code)) {
        return res.status(400).json({
          error: "كود غير صحيح"
        });
      }

      await collection.updateOne(
        { _id: code },
        {
          $addToSet: {
            ab: String(body.d || "")
          }
        }
      );

      return res.json({ ok: true });
    }

    // حذف طالب
    if (body.action === "delete") {
      const code = String(body.c || "");

      if (!/^\d{4,12}$/.test(code)) {
        return res.status(400).json({
          error: "كود غير صحيح"
        });
      }

      await collection.deleteOne({
        _id: code
      });

      return res.json({ ok: true });
    }

    return res.sendStatus(400);

  } catch (error) {
    console.error("Admin API error:", error.message);

    return res.status(500).json({
      error: "حدث خطأ أثناء تنفيذ العملية"
    });
  }
});

// إعدادات الموقع التي يتحكم بها محرر الموقع الشامل
const { DEFAULT_SITE_SETTINGS, sanitizeSiteSettings } = require("./site-settings");
app.get("/api/site-settings", async (req, res) => {
  try {
    const saved = await (await db()).collection("site_settings").findOne({ _id: "global" });
    const settings = sanitizeSiteSettings(saved && saved.settings ? saved.settings : DEFAULT_SITE_SETTINGS);
    res.set("Cache-Control", "no-store");
    return res.json(settings);
  } catch (error) {
    console.error("Site settings read error:", error.message);
    return res.status(503).json({ error: "تعذر تحميل إعدادات الموقع" });
  }
});

app.post("/api/site-settings", async (req, res) => {
  const b = req.body || {};
  if (!process.env.ADMIN_CODE || String(b.pass || "") !== process.env.ADMIN_CODE) {
    return res.sendStatus(401);
  }
  try {
    if (b.action === "get") {
      const saved = await (await db()).collection("site_settings").findOne({ _id: "global" });
      return res.json(sanitizeSiteSettings(saved && saved.settings ? saved.settings : DEFAULT_SITE_SETTINGS));
    }
    if (b.action === "save") {
      const settings = sanitizeSiteSettings(b.settings || {});
      await (await db()).collection("site_settings").updateOne(
        { _id: "global" },
        { $set: { settings, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );
      return res.json({ ok: true, settings });
    }
    return res.status(400).json({ error: "طلب غير معروف" });
  } catch (error) {
    console.error("Site settings save error:", error.message);
    return res.status(500).json({ error: "تعذر حفظ إعدادات الموقع" });
  }
});

// إدارة محتوى الأقسام (سيارات، عقارات، وظائف ...) — المسار الذي تطلبه لوحة /admin
const SECTIONS = ["cars", "realestate", "jobs", "shops", "medical", "tourism", "study"];

app.post("/api/content", async (req, res) => {
  const b = req.body || {};

  if (!process.env.ADMIN_CODE || String(b.pass || "") !== process.env.ADMIN_CODE) {
    return res.sendStatus(401);
  }

  const section = String(b.section || "");
  if (!SECTIONS.includes(section)) {
    return res.status(400).json({ error: "قسم غير صحيح" });
  }

  try {
    const col = (await db()).collection("content");

    if (b.action === "list") {
      const list = await col.find({ section }).sort({ updatedAt: -1 }).limit(500).toArray();
      return res.json(list.map(d => ({ ...d, _id: String(d._id) })));
    }

    if (b.action === "save") {
      const i = b.item || {};
      const title = String(i.title || "").trim().slice(0, 180);
      if (!title) return res.status(400).json({ error: "العنوان مطلوب" });

      const imgs = (Array.isArray(i.images) ? i.images : [])
        .map(String).filter(x => ObjectId.isValid(x)).slice(0, 8);
      const image = String(i.image || "").trim();
      const doc = {
        section,
        title,
        price: String(i.price || "").slice(0, 80),
        location: String(i.location || "").slice(0, 120),
        contact: String(i.contact || "").slice(0, 40),
        image: /^https?:\/\//i.test(image) ? image.slice(0, 500) : "",
        status: i.status === "draft" ? "draft" : "published",
        description: String(i.description || "").slice(0, 5000),
        images: imgs,
        updatedAt: new Date()
      };

      if (i._id) {
        if (!ObjectId.isValid(String(i._id))) return res.status(400).json({ error: "معرّف غير صحيح" });
        const oid = new ObjectId(String(i._id));
        const old = await col.findOne({ _id: oid, section });
        await col.updateOne({ _id: oid, section }, { $set: doc });
        // حذف الصور التي أُزيلت من المنشور
        const removed = ((old && old.images) || []).filter(x => !imgs.includes(x) && ObjectId.isValid(x));
        if (removed.length) {
          await (await db()).collection("images").deleteMany({ _id: { $in: removed.map(x => new ObjectId(x)) } });
        }
      } else {
        await col.insertOne({ ...doc, createdAt: new Date() });
      }
      return res.json({ ok: true });
    }

    if (b.action === "delete") {
      if (!ObjectId.isValid(String(b.id || ""))) return res.status(400).json({ error: "معرّف غير صحيح" });
      const oid = new ObjectId(String(b.id));
      const old = await col.findOne({ _id: oid, section });
      await col.deleteOne({ _id: oid, section });
      const gone = ((old && old.images) || []).filter(x => ObjectId.isValid(x));
      if (gone.length) {
        await (await db()).collection("images").deleteMany({ _id: { $in: gone.map(x => new ObjectId(x)) } });
      }
      return res.json({ ok: true });
    }

    return res.sendStatus(400);
  } catch (error) {
    console.error("Content API error:", error.message);
    return res.status(500).json({ error: "حدث خطأ أثناء تنفيذ العملية" });
  }
});

// عرض المنشورات المنشورة للزوار (للقراءة فقط، المسودات لا تظهر)
app.get("/api/posts", async (req, res) => {
  const section = String(req.query.section || "");
  if (!SECTIONS.includes(section)) return res.sendStatus(404);

  try {
    const list = await (await db())
      .collection("content")
      .find({ section, status: "published" })
      .sort({ updatedAt: -1 })
      .limit(200)
      .toArray();

    res.set("Cache-Control", "no-store");
    res.json(list.map(d => ({
      id: String(d._id),
      title: d.title || "",
      price: d.price || "",
      location: d.location || "",
      contact: d.contact || "",
      image: d.image || "",
      images: (d.images || []).map(x => "/api/img/" + x),
      description: d.description || "",
      date: d.updatedAt || d.createdAt || null
    })));
  } catch (error) {
    console.error("Posts API error:", error.message);
    res.status(500).json({ error: "حدث خطأ في الخادم" });
  }
});

// رفع صورة من المعرض (المدير فقط). تصل مضغوطة من الصفحة بصيغة data URL
app.post("/api/upload", async (req, res) => {
  const b = req.body || {};
  if (!process.env.ADMIN_CODE || String(b.pass || "") !== process.env.ADMIN_CODE) {
    return res.sendStatus(401);
  }

  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.data || ""));
  if (!m) return res.status(400).json({ error: "صيغة الصورة غير مدعومة" });

  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 1500000) return res.status(413).json({ error: "الصورة كبيرة جداً" });

  try {
    const r = await (await db()).collection("images").insertOne({
      type: m[1],
      data: new Binary(buf),
      createdAt: new Date()
    });
    res.json({ ok: true, id: String(r.insertedId) });
  } catch (error) {
    console.error("Upload error:", error.message);
    res.status(500).json({ error: "تعذر حفظ الصورة" });
  }
});

// عرض الصورة للجميع
app.get("/api/img/:id", async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.sendStatus(404);
  try {
    const d = await (await db()).collection("images").findOne({ _id: new ObjectId(req.params.id) });
    if (!d) return res.sendStatus(404);
    res.set({
      "Content-Type": d.type,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff"
    });
    res.send(Buffer.from(d.data.buffer));
  } catch (error) {
    res.sendStatus(500);
  }
});


// لعبة تكملة الأغاني: تخزين المقاطع الصوتية المصرح باستخدامها في MongoDB.
function normalizeGameAnswer(value) {
  return String(value || "").toLowerCase().normalize("NFD")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
    .replace(/ؤ/g, "و").replace(/ئ/g, "ي")
    .replace(/[^\u0600-\u06FFa-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
function gameAnswerDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}
function gameAnswerIsClose(input, target) {
  const a = normalizeGameAnswer(input), b = normalizeGameAnswer(target);
  if (!a || !b) return false;
  if (a === b) return true;
  const aa = a.replace(/\s/g, ""), bb = b.replace(/\s/g, "");
  if (!aa || !bb) return false;
  const ratio = 1 - gameAnswerDistance(aa, bb) / Math.max(aa.length, bb.length);
  const threshold = bb.length < 10 ? 0.80 : bb.length < 18 ? 0.74 : 0.70;
  if (ratio >= threshold && aa.length >= bb.length * 0.68) return true;
  const wordsA = a.split(" "), wordsB = b.split(" ").filter(Boolean);
  const matched = wordsB.filter(word => wordsA.some(other => {
    const longest = Math.max(word.length, other.length);
    return word === other || (longest >= 5 && gameAnswerDistance(word, other) <= 1);
  })).length;
  return matched >= Math.ceil(wordsB.length * 0.8) && matched >= 2;
}

app.get("/api/game-audio", async (req, res) => {
  try {
    const clips = await (await db()).collection("game_audio")
      .find({}, { projection: { title: 1, startAt: 1, endAt: 1, createdAt: 1 } })
      .sort({ createdAt: -1 }).limit(100).toArray();
    res.json(clips.map(x => ({ id: String(x._id), title: x.title, startAt: x.startAt, endAt: x.endAt })));
  } catch (error) {
    console.error("Game audio list error:", error.message);
    res.status(500).json({ error: "تعذر تحميل المقاطع الصوتية" });
  }
});

app.post("/api/game-audio/upload", async (req, res) => {
  const body = req.body || {};
  if (!process.env.ADMIN_CODE || String(body.pass || "") !== process.env.ADMIN_CODE) {
    return res.status(401).json({ error: "رمز الإدارة غير صحيح" });
  }
  const match = /^data:(audio\/(?:mpeg|mp3|mp4|m4a|x-m4a|wav|x-wav|ogg|webm|aac));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ""));
  if (!match) return res.status(400).json({ error: "صيغة الصوت غير مدعومة. استخدم MP3 أو M4A أو WAV أو OGG أو WEBM" });
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > 8 * 1024 * 1024) return res.status(413).json({ error: "حجم المقطع يجب ألا يتجاوز 8 ميغابايت" });
  const title = String(body.title || "").trim().slice(0, 70);
  const answer = String(body.answer || "").trim().slice(0, 400);
  const startAt = Number(body.startAt), endAt = Number(body.endAt);
  if (!title || !answer) return res.status(400).json({ error: "اسم المقطع والتكملة الصحيحة مطلوبان" });
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || startAt < 0 || endAt <= startAt || endAt - startAt < 1 || endAt > 900) {
    return res.status(400).json({ error: "وقت المقطع غير صحيح" });
  }
  try {
    const result = await (await db()).collection("game_audio").insertOne({
      title, answer, startAt, endAt, type: match[1], data: new Binary(buffer), createdAt: new Date()
    });
    res.json({ ok: true, id: String(result.insertedId) });
  } catch (error) {
    console.error("Game audio upload error:", error.message);
    res.status(500).json({ error: "تعذر حفظ المقطع الصوتي" });
  }
});

app.get("/api/game-audio/:id", async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.sendStatus(404);
  try {
    const clip = await (await db()).collection("game_audio").findOne({ _id: new ObjectId(req.params.id) });
    if (!clip || !clip.data) return res.sendStatus(404);
    res.set({
      "Content-Type": clip.type || "audio/mpeg",
      "Content-Length": String(clip.data.buffer.length),
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff"
    });
    res.send(Buffer.from(clip.data.buffer));
  } catch (error) {
    console.error("Game audio playback error:", error.message);
    res.sendStatus(500);
  }
});

app.post("/api/game-audio/:id/check", async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.sendStatus(404);
  const answer = String((req.body || {}).answer || "").trim().slice(0, 400);
  if (!answer) return res.status(400).json({ error: "اكتب التكملة أولاً" });
  try {
    const clip = await (await db()).collection("game_audio").findOne(
      { _id: new ObjectId(req.params.id) }, { projection: { title: 1, answer: 1 } }
    );
    if (!clip) return res.sendStatus(404);
    const exact = normalizeGameAnswer(answer) === normalizeGameAnswer(clip.answer);
    const accepted = gameAnswerIsClose(answer, clip.answer);
    res.json({ accepted, exact, points: accepted ? (exact ? 10 : 8) : 0, correctAnswer: clip.answer });
  } catch (error) {
    console.error("Game audio answer check error:", error.message);
    res.status(500).json({ error: "تعذر التحقق من الإجابة" });
  }
});

// المنصة الدراسية (الطلاب، الملازم، المحاضرات، الامتحانات)
require("./study-api")(app, db, express);
require("./community-api")(app, db, express);
require("./groups-api")(app, db, express);
require("./private-messages-api")(app, db, express);

// إحصائيات الزوار والمشاهدات
require("./analytics")(app, db);

// تشغيل الخادم
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
 
