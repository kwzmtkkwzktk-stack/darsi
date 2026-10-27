// السماح للزوار بنشر منشورات (مثلاً في قسم السيارات) مع صور، وحذف منشورهم بأنفسهم
const crypto = require("crypto");
const { ObjectId, Binary } = require("mongodb");

module.exports = function (app, db) {
  // ===== إعدادات يمكنك تعديلها =====
  const PUBLIC_SECTIONS = ["cars"]; // الأقسام التي يستطيع أي زائر النشر فيها (مثال: ["cars", "realestate", "jobs"])
  const AUTO_PUBLISH = true;        // true = يظهر المنشور فوراً، false = يبقى مسودة حتى توافق عليه من لوحة الإدارة
  const MAX_IMAGES = 5;

  app.set("trust proxy", 1);

  const col = async (n) => (await db()).collection(n);
  const S = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
  const oid = (v) => (ObjectId.isValid(String(v)) ? new ObjectId(String(v)) : null);
  const hash = (k) => crypto.createHash("sha256").update(String(k)).digest("hex");
  const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
  const need = (c, msg, status) => { if (!c) throw bad(msg, status); };

  // حماية من الإزعاج: عدد محدود من العمليات لكل عنوان في الساعة
  const hits = new Map();
  function tooMany(key, max, ms) {
    const now = Date.now();
    const a = (hits.get(key) || []).filter((t) => now - t < ms);
    a.push(now);
    hits.set(key, a);
    if (hits.size > 5000) hits.clear();
    return a.length > max;
  }
  const fail = (res, e) => {
    if (e && e.status) return res.status(e.status).json({ error: e.message });
    console.error("Public posts error:", e && e.message);
    res.status(500).json({ error: "حدث خطأ في الخادم" });
  };

  app.get("/api/public/config", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ sections: PUBLIC_SECTIONS, autoPublish: AUTO_PUBLISH, maxImages: MAX_IMAGES });
  });

  // رفع صورة واحدة (تصل مضغوطة من الصفحة)
  const MAGIC = { "image/jpeg": [0xff, 0xd8], "image/png": [0x89, 0x50, 0x4e, 0x47], "image/webp": [0x52, 0x49, 0x46, 0x46] };
  app.post("/api/public/upload", async (req, res) => {
    if (tooMany("pu" + req.ip, 25, 3600000)) return res.sendStatus(429);
    try {
      const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String((req.body && req.body.data) || ""));
      need(m, "صيغة الصورة غير مدعومة");
      const buf = Buffer.from(m[2], "base64");
      need(buf.length <= 700000, "الصورة كبيرة جداً");
      need(MAGIC[m[1]].every((b, i) => buf[i] === b), "الصورة غير صالحة");
      const r = await (await col("images")).insertOne({ type: m[1], data: new Binary(buf), source: "public", used: false, createdAt: new Date() });
      res.json({ ok: true, id: String(r.insertedId) });
    } catch (e) { fail(res, e); }
  });

  // نشر منشور جديد
  app.post("/api/public/post", async (req, res) => {
    const b = req.body || {};
    if (b.website) return res.json({ ok: true }); // حقل مخفي: الروبوتات فقط تملؤه
    if (tooMany("pp" + req.ip, 6, 3600000)) return res.status(429).json({ error: "نشرت منشورات كثيرة، حاول بعد قليل" });
    try {
      const section = S(b.section, 30);
      need(PUBLIC_SECTIONS.includes(section), "النشر غير متاح في هذا القسم");
      const title = S(b.title, 120);
      need(title.length >= 3, "اكتب عنواناً واضحاً (3 أحرف على الأقل)");
      const contact = S(b.contact, 25).replace(/[^\d+\s-]/g, "");
      need(contact.replace(/\D/g, "").length >= 7, "اكتب رقم هاتف صحيح للتواصل");

      const ids = (Array.isArray(b.images) ? b.images : []).map(String).filter((x) => ObjectId.isValid(x)).slice(0, MAX_IMAGES);
      if (ids.length) {
        const found = await (await col("images")).find({ _id: { $in: ids.map((x) => new ObjectId(x)) }, source: "public" }).toArray();
        need(found.length === ids.length, "إحدى الصور غير صالحة، أعد رفعها");
      }

      const key = crypto.randomBytes(16).toString("hex");
      const now = new Date();
      const doc = {
        section, title,
        price: S(b.price, 60),
        location: S(b.location, 100),
        contact,
        image: "",
        images: ids,
        status: AUTO_PUBLISH ? "published" : "draft",
        description: S(b.description, 2000),
        source: "public",
        keyHash: hash(key),
        createdAt: now,
        updatedAt: now
      };
      const r = await (await col("content")).insertOne(doc);
      if (ids.length) await (await col("images")).updateMany({ _id: { $in: ids.map((x) => new ObjectId(x)) } }, { $set: { used: true } });
      res.json({ ok: true, id: String(r.insertedId), key, status: doc.status });
    } catch (e) { fail(res, e); }
  });

  // حذف المنشور بواسطة صاحبه (بالمفتاح المحفوظ على جهازه)
  app.post("/api/public/delete", async (req, res) => {
    if (tooMany("pd" + req.ip, 30, 3600000)) return res.sendStatus(429);
    try {
      const id = oid(req.body && req.body.id);
      const key = S(req.body && req.body.key, 100);
      need(id && key, "بيانات غير صحيحة");
      const c = await col("content");
      const d = await c.findOne({ _id: id, source: "public" });
      need(d && d.keyHash, "المنشور غير موجود", 404);
      need(crypto.timingSafeEqual(Buffer.from(hash(key)), Buffer.from(d.keyHash)), "غير مسموح بحذف هذا المنشور", 403);
      await c.deleteOne({ _id: id });
      const gone = (d.images || []).filter((x) => ObjectId.isValid(x)).map((x) => new ObjectId(x));
      if (gone.length) await (await col("images")).deleteMany({ _id: { $in: gone } });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // تنظيف الصور المرفوعة التي لم يُنشر لها منشور (كل 6 ساعات)
  const timer = setInterval(async () => {
    try {
      await (await col("images")).deleteMany({ source: "public", used: { $ne: true }, createdAt: { $lt: new Date(Date.now() - 864e5) } });
    } catch (e) { /* تجاهل */ }
  }, 6 * 3600 * 1000);
  if (timer.unref) timer.unref();
};
