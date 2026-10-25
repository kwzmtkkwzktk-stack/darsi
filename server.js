
const express = require("express");
const path = require("path");
const { MongoClient } = require("mongodb");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "1mb" }));\napp.use(express.static(path.join(__dirname, "public")));

let client;
let dbPromise;

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

// الصفحة الرئيسية من مجلد public
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// لوحة المدير
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// بيانات الطالب حسب الكود
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

    if (!student) return res.sendStatus(404);

    res.json({
      n: student.n || "",
      g: student.g || "",
      x: student.x || {},
      ab: student.ab || []
    });
  } catch (error) {
    console.error("Student API error:", error.message);
    res.status(500).json({ error: "حدث خطأ في الخادم" });
  }
});

// لوحة الإدارة
app.post("/api/admin", async (req, res) => {
  const body = req.body || {};

  if (
    !process.env.ADMIN_CODE ||
    String(body.pass || "") !== process.env.ADMIN_CODE
  ) {
    return res.sendStatus(401);
  }

  try {
    const collection = (await db()).collection("students");

    if (body.action === "check") {
      return res.json({ ok: true });
    }

    // إنشاء طالب جديد وكود دخول فريد
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
          if (error.code !== 11000) throw error;
        }
      }

      if (!created) {
        throw new Error("Could not generate a unique student code");
      }

      return res.status(201).json({
        ok: true,
        student: { c: code, n: name }
      });
    }

    // عرض الطلاب
    if (body.action === "list") {
      const students = await collection
        .find({}, { projection: { n: 1 } })
        .sort({ n: 1 })
        .toArray();

      return res.json(
        students.map(student => ({
          c: student._id,
          n: student.n || ""
        }))
      );
    }

    // نشر الدرجات
    if (body.action === "publish") {
      const items = Array.isArray(body.items) ? body.items : [];

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
            filter: { _id: String(item.c) },
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

      return res.json({ ok: true, n: operations.length });
    }

    // تسجيل غياب
    if (body.action === "absence") {
      const code = String(body.c || "");

      if (!/^\d{4,12}$/.test(code)) {
        return res.status(400).json({ error: "كود غير صحيح" });
      }

      await collection.updateOne(
        { _id: code },
        { $addToSet: { ab: String(body.d || "") } }
      );

      return res.json({ ok: true });
    }

    // حذف طالب
    if (body.action === "delete") {
      const code = String(body.c || "");

      if (!/^\d{4,12}$/.test(code)) {
        return res.status(400).json({ error: "كود غير صحيح" });
      }

      await collection.deleteOne({ _id: code });
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

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
