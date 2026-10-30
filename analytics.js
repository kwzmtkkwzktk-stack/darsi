// إحصائيات الزوار ومعلومات الموقع (بدون تخزين أي عنوان IP)
const crypto = require("crypto");

module.exports = function (app, db) {
  app.set("trust proxy", 1);

  const col = async (n) => (await db()).collection(n);
  const SECTIONS = ["cars", "realestate", "jobs", "shops", "medical", "tourism", "study"];
  const PAGES = ["home", "section", "study"];
  const SECRET = "darsi-stats-" + (process.env.ADMIN_CODE || "x");
  const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|curl|wget|python|java\/|httpclient|monitor|uptime|lighthouse|pingdom|render\//i;

  // التاريخ والساعة بتوقيت بغداد (UTC+3)
  const baghdad = (ms = Date.now()) => new Date(ms + 3 * 3600 * 1000);
  const dayKey = (ms) => baghdad(ms).toISOString().slice(0, 10);

  const hits = new Map();
  function tooMany(key, max, ms) {
    const now = Date.now();
    const a = (hits.get(key) || []).filter((t) => now - t < ms);
    a.push(now);
    hits.set(key, a);
    if (hits.size > 5000) hits.clear();
    return a.length > max;
  }
  const fails = new Map();

  function refKind(ref, host) {
    ref = String(ref || "").toLowerCase();
    if (!ref) return "direct";
    let h = "";
    try { h = new URL(ref).hostname; } catch (e) { return "other"; }
    if (host && h === String(host).split(":")[0].toLowerCase()) return "direct";
    if (/facebook|fb\.com|fb\.me/.test(h)) return "facebook";
    if (/whatsapp|wa\.me/.test(h)) return "whatsapp";
    if (/google/.test(h)) return "google";
    if (/t\.me|telegram/.test(h)) return "telegram";
    if (/instagram/.test(h)) return "instagram";
    if (/tiktok/.test(h)) return "tiktok";
    if (/youtube|youtu\.be/.test(h)) return "youtube";
    return "other";
  }

  // ---- تسجيل زيارة (تُرسَل من الصفحة العامة) ----
  app.post("/api/track", async (req, res) => {
    try {
      if (tooMany("t" + req.ip, 200, 60000)) return res.sendStatus(204);
      const ua = String(req.get("user-agent") || "");
      const b = req.body || {};
      const page = String(b.p || "");
      if (!ua || BOT.test(ua) || !PAGES.includes(page)) return res.sendStatus(204);
      const section = SECTIONS.includes(String(b.s || "")) ? String(b.s) : "";

      const now = Date.now();
      const day = dayKey(now);
      const hour = baghdad(now).getUTCHours();
      const device = /ipad|tablet/i.test(ua) ? "tablet" : /mobi|android|iphone/i.test(ua) ? "mobile" : "desktop";
      const vid = crypto.createHash("sha256").update(SECRET + day + String(req.ip) + ua).digest("hex").slice(0, 24);

      const r = await (await col("st_visitors")).updateOne(
        { _id: day + "|" + vid },
        { $setOnInsert: { day }, $set: { seen: new Date(now) } },
        { upsert: true }
      );
      const inc = { views: 1 };
      inc["pages." + page] = 1;
      inc["hours." + hour] = 1;
      if (section) inc["sections." + section] = 1;
      if (r && r.upsertedCount > 0) {
        inc.uniques = 1;
        inc["devices." + device] = 1;
        inc["refs." + refKind(b.ref, req.get("host"))] = 1;
      }
      await (await col("st_daily")).updateOne({ _id: day }, { $inc: inc }, { upsert: true });

      // تنظيف بيانات الزوار الأقدم من 35 يوماً (أحياناً فقط)
      if (Math.random() < 0.01) {
        await (await col("st_visitors")).deleteMany({ day: { $lt: dayKey(now - 35 * 864e5) } });
      }
      res.sendStatus(204);
    } catch (e) {
      console.error("Track error:", e && e.message);
      res.sendStatus(204);
    }
  });

  // ---- معلومات الموقع للمدير ----
  app.post("/api/stats", async (req, res) => {
    const key = String(req.ip || "x");
    const now = Date.now();
    const a = (fails.get(key) || []).filter((t) => now - t < 600000);
    if (a.length >= 15) return res.sendStatus(429);
    const pass = String((req.body && req.body.pass) || "");
    if (!process.env.ADMIN_CODE || pass !== process.env.ADMIN_CODE) {
      a.push(now);
      fails.set(key, a);
      return res.sendStatus(401);
    }
    try {
      const daily = await (await col("st_daily")).find({}).sort({ _id: -1 }).limit(4000).toArray();
      const map = {};
      daily.forEach((d) => { map[d._id] = d; });
      const get = (k) => map[k] || {};

      const keys = (n) => Array.from({ length: n }, (_, i) => dayKey(now - i * 864e5)); // الأحدث أولاً
      const sum = (ks) => ks.reduce((s, k) => ({ u: s.u + (get(k).uniques || 0), v: s.v + (get(k).views || 0) }), { u: 0, v: 0 });
      const k30 = keys(30);
      const merge = (field) => {
        const o = {};
        k30.forEach((k) => Object.entries(get(k)[field] || {}).forEach(([n, c]) => { o[n] = (o[n] || 0) + c; }));
        return o;
      };

      const total = daily.reduce((s, d) => ({ u: s.u + (d.uniques || 0), v: s.v + (d.views || 0) }), { u: 0, v: 0 });
      const since = daily.length ? daily[daily.length - 1]._id : null;

      const online = await (await col("st_visitors")).countDocuments({ seen: { $gt: new Date(now - 5 * 60000) } });

      const content = await col("content");
      const perSection = {};
      for (const s of SECTIONS) {
        perSection[s] = {
          published: await content.countDocuments({ section: s, status: "published" }),
          draft: await content.countDocuments({ section: s, status: "draft" })
        };
      }
      const count = async (n) => (await col(n)).countDocuments({});
      const latest = (await content.find({}).sort({ updatedAt: -1 }).limit(6).toArray()).map((d) => ({
        title: d.title, section: d.section, status: d.status, source: d.source || "admin", date: d.updatedAt || d.createdAt || null
      }));

      res.set("Cache-Control", "no-store");
      res.json({
        now: new Date(now),
        online,
        today: sum([keys(1)[0]]),
        yesterday: sum([keys(2)[1]]),
        week: sum(keys(7)),
        month: sum(k30),
        total,
        since,
        daily: keys(14).reverse().map((k) => ({ d: k, u: get(k).uniques || 0, v: get(k).views || 0 })),
        pages: merge("pages"),
        sections: merge("sections"),
        devices: merge("devices"),
        refs: merge("refs"),
        hours: merge("hours"),
        content: {
          sections: perSection,
          publicPosts: await content.countDocuments({ source: "public" }),
          students: await count("st_students"),
          files: await count("st_files"),
          videos: await count("st_videos"),
          questions: await count("st_questions"),
          news: await count("st_news"),
          paper: await count("st_paper")
        },
        latest
      });
    } catch (e) {
      console.error("Stats error:", e && e.message);
      res.status(500).json({ error: "حدث خطأ في الخادم" });
    }
  });
};
