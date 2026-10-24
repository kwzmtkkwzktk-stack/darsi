const { MongoClient } = require("mongodb");
let p;
const db = () => (p ||= new MongoClient(process.env.MONGODB_URI).connect().then(c => c.db("darsi")));

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();
  const b = req.body || {};
  if (!process.env.ADMIN_CODE || String(b.pass) !== process.env.ADMIN_CODE) return res.status(401).end();
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
    res.status(400).end();
  } catch (e) {
    res.status(500).end();
  }
};
