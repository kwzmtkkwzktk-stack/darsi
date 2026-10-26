const { MongoClient } = require("mongodb");
let p;
const db = () => (p ||= new MongoClient(process.env.MONGODB_URI).connect().then(c => c.db("darsi")));

module.exports = async (req, res) => {
  try {
    const code = String(req.query.code || "").replace(/\D/g, "");
    if (code.length < 4) return res.status(404).end();
    const d = await (await db()).collection("students").findOne({ _id: code });
    if (!d) return res.status(404).end();
    res.setHeader("Cache-Control", "no-store");
    res.json({ n: d.n, g: d.g, x: d.x || {}, ab: d.ab || [] });
  } catch (e) {
    res.status(500).end();
  }
};
