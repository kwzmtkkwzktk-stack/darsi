
const express = require("express");
const path = require("path");
const { MongoClient } = require("mongodb");

const app = express();

app.use(express.json({ limit: "1mb" }));

// إعدادات قاعدة البيانات
let dbPromise;

async function db() {
  if (!dbPromise) {
    if (!process.env.MONGODB_URI) {
      throw new Error("MONGODB_URI is not configured");
    }

    dbPromise = new MongoClient(process.env.MONGODB_URI)
      .connect()
      .then(client => client.db("darsi"))
      .catch(error => {
        dbPromise = null;
        throw error;
      });
  }

  return dbPromise;
}

// الصفحة الرئيسية
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index-1.html"), err => {
    if (err && !res.headersSent) {
      res.status(500).send(
        "تعذر فتح صفحة الموقع. تأكد من وجود ملف index-1.html."
      );
    }
  });
});

// البحث عن بيانات الطالب
app.get("/api/student", async (req, res) => {
  try {
    const code = String(req.query.code || "").replace(/\D/g, "");

    if (code.length < 4) {
      return res.sendStatus(404);
    }

    const collection = (await db()).collection("students");
    const student = await collection.findOne({ _id: code });

    if (!student) {
      return res.sendStatus(404);
    }

    res.set("Cache-Control", "no-store");

    return res.json({
      n: student.n,
      g: student.g,
      x: student.x || {},
      ab: student.ab || []
    });
  } catch (error) {
    console.error("Student API error:", error);
    return res.status(500).json({
      error: "حدث خطأ في الخادم"
    });
  }
});

// إدارة بيانات الطلاب
app.post("/api/admin", async (req, res) => {
  const body = req.body || {};

  if (
    !process.env.ADMIN_CODE ||
    String(body.pass) !== process.env.ADMIN_CODE
  ) {
    return res.sendStatus(401);
  }

  try {
    const collection = (await db()).collection("students");

    if (body.action === "check") {
      return res.json({ ok: true });
    }

    if (body.action === "list") {
      const students = await collection
        .find({}, { projection: { n: 1 } })
        .sort({ n: 1 })
        .toArray();

      return res.json(
        students.map(student => ({
          c: student._id,
          n: student.n
        }))
      );
    }

    if (body.action === "publish") {
      const items = Array.isArray(body.items) ? body.items : [];

      const operations = items
        .filter(item =>
          item &&
          /^\d{4,}$/.test(String(item.c)) &&
          Number(item.e) >= 0 &&
          Number(item.e) <= 5 &&
          Array.isArray(item.m)
        )
        .map(item => ({
          updateOne: {
            filter: { _id: String(item.c) },
            update: {
              $set: {
                n: String(item.n),
                g: String(item.g),
                ["x." + Number(item.e)]: item.m.map(([subject, value]) => [
                  String(subject),
                  Number(value)
                ])
              }
            },
            upsert: true
          }
        }));

      if (operations.length > 0) {
        await collection.bulkWrite(operations);
      }

      return res.json({
        ok: true,
        n: operations.length
      });
    }

    if (body.action === "absence") {
      await collection.updateOne(
        { _id: String(body.c) },
        { $addToSet: { ab: String(body.d) } }
      );

      return res.json({ ok: true });
    }

    if (body.action === "delete") {
      await collection.deleteOne({
        _id: String(body.c)
      });

      return res.json({ ok: true });
    }

    return res.sendStatus(400);
  } catch (error) {
    console.error("Admin API error:", error);

    return res.status(500).json({
      error: "حدث خطأ أثناء تنفيذ العملية"
    });
  }
});

// تشغيل الخادم على Render
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
