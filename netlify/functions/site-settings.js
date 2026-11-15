const { MongoClient } = require("mongodb");
const { DEFAULT_SITE_SETTINGS, sanitizeSiteSettings } = require("../../site-settings");
let clientPromise;
async function db() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not configured");
  if (!clientPromise) clientPromise = new MongoClient(process.env.MONGODB_URI).connect().then(c => c.db("darsi"));
  return clientPromise;
}
const response = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  body: JSON.stringify(body || {})
});

exports.handler = async event => {
  try {
    const collection = (await db()).collection("site_settings");
    if (event.httpMethod === "GET") {
      const saved = await collection.findOne({ _id: "global" });
      return response(200, sanitizeSiteSettings(saved && saved.settings ? saved.settings : DEFAULT_SITE_SETTINGS));
    }
    if (event.httpMethod !== "POST") return response(405, { error: "Method not allowed" });

    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch (_) { return response(400, { error: "Invalid JSON" }); }
    if (!process.env.ADMIN_CODE || String(body.pass || "") !== process.env.ADMIN_CODE) return response(401, { error: "Unauthorized" });

    if (body.action === "get") {
      const saved = await collection.findOne({ _id: "global" });
      return response(200, sanitizeSiteSettings(saved && saved.settings ? saved.settings : DEFAULT_SITE_SETTINGS));
    }
    if (body.action === "save") {
      const settings = sanitizeSiteSettings(body.settings || {});
      await collection.updateOne(
        { _id: "global" },
        { $set: { settings, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );
      return response(200, { ok: true, settings });
    }
    return response(400, { error: "Unknown action" });
  } catch (error) {
    console.error("Site settings function error:", error.message);
    return response(500, { error: "Could not load or save site settings" });
  }
};
