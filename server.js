const express = require("express");
const { MongoClient } = require("mongodb");

const app = express();
app.use(express.json({ limit: "1mb" }));

let p;
const db = () => (p ||= new MongoClient(process.env.MONGODB_URI).connect().then(c => c.db("darsi")));

app.get("/", (req, res) => res.sendFile(__dirname + "/index.html"));

app.get("/api/student", async (req, res) => {
  try {
    const code = String(req.query.code || "").replace(/\D/g, "");
    if (code.length < 4) return res.sendStatus(404);
    const d = await (await db()).collection("students").findOne({ _id: code });
    if (!d) return res.sendStatus(404);
    res.set("Cache-Control", "no-store");
    res.json({ n: d.n, g: d.g, x: d.x || {}, ab: d.ab || [] });
  } catch (e) {
    res.sendStatus(500);
  }
});

app.post("/api/admin", async (req, res) => {
  const b = req.body || {};
  if (!process.env.ADMIN_CODE || String(b.pass) !== process.env.ADMIN_CODE) return res.sendStatus(401);
  try {
    const col = (await db()).collection("students");
    if (b.action === "check") return res.json({ ok: true });
    if (b.action === "list") {
      const l = await col.find({}, { projection: { n: 1 } }).sort({ n: 1 }).toArray();
      return res.json(l.map(s => ({ c: s._id, n: s.n })));
    }
    if (b.action === "publish") {
      const ops = (Array.isArray(b.items) ? b.items : [])
        .filter(i => i && /^\d{4,}$/.test(String(i.c)) && Number(i.e) >= 0 && Number(i.e) <= 5 && Array.isArray(i.m))
        .map(i => ({
          updateOne: {
            filter: { _id: String(i.c) },
            update: { $set: { n: String(i.n), g: String(i.g), ["x." + Number(i.e)]: i.m.map(([s, v]) => [String(s), Number(v)]) } },
            upsert: true
          }
        }));
      if (ops.length) await col.bulkWrite(ops);
      return res.json({ ok: true, n: ops.length });
    }
    if (b.action === "absence") {
      await col.updateOne({ _id: String(b.c) }, { $addToSet: { ab: String(b.d) } });
      return res.json({ ok: true });
    }
    if (b.action === "delete") {
      await col.deleteOne({ _id: String(b.c) });
      return res.json({ ok: true });
    }
    res.sendStatus(400);
  } catch (e) {
    res.sendStatus(500);
  }
});

app.listen(process.env.PORT || 3000);
