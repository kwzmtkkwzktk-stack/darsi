const { ObjectId } = require('mongodb');

// مجموعات الطلاب والمحادثات الخاصة بكل مجموعة.
module.exports = function groupsAPI(app, db) {
  db().then(async database => {
    await database.collection('community_groups').createIndex({ username: 1 }, { unique: true });
    await database.collection('community_group_members').createIndex({ groupId: 1, userId: 1 }, { unique: true });
    await database.collection('community_group_members').createIndex({ userId: 1, pinned: 1 });
    await database.collection('community_group_messages').createIndex({ groupId: 1, createdAt: 1 });
  }).catch(e => console.error('Groups indexes:', e.message));

  const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  const fail = (res, e) => {
    console.error('Groups API:', e.message);
    res.status(500).json({ error: 'حدث خطأ بالخادم. حاول مرة ثانية.' });
  };
  function identity(req, res) {
    const id = clean(req.body?.deviceId || req.query.deviceId, 80);
    if (!/^[a-zA-Z0-9_-]{24,80}$/.test(id)) {
      res.status(401).json({ error: 'أنشئ يوزرك في مجتمع دَرسي أولاً.' });
      return null;
    }
    return id;
  }
  async function profile(database, id) {
    return database.collection('community_profiles').findOne({ _id: id });
  }
  function validId(value) { return ObjectId.isValid(String(value || '')); }
  async function member(database, groupId, userId) {
    return database.collection('community_group_members').findOne({ groupId, userId });
  }
  function publicGroup(g, mine) {
    return {
      id: String(g._id), name: g.name, username: g.username,
      creatorName: g.creatorName, creatorUsername: g.creatorUsername,
      membersCount: Number(g.membersCount || 0), createdAt: g.createdAt,
      joined: !!mine, pinned: !!(mine && mine.pinned), isMine: !!(mine && mine.isCreator)
    };
  }

  // إنشاء مجموعة: اسم ظاهر واسم مستخدم فريد للمجموعة.
  app.post('/api/community/groups/create', async (req, res) => {
    try {
      const userId = identity(req, res); if (!userId) return;
      const database = await db();
      const p = await profile(database, userId);
      if (!p) return res.status(403).json({ error: 'أنشئ حسابك في مجتمع دَرسي أولاً.' });
      const name = clean(req.body.name, 50);
      const username = clean(req.body.username, 24).toLowerCase().replace(/[^a-z0-9_]/g, '');
      if (name.length < 3) return res.status(400).json({ error: 'اسم المجموعة لازم يكون 3 أحرف على الأقل.' });
      if (!/^[a-z0-9_]{3,24}$/.test(username)) return res.status(400).json({ error: 'يوزر المجموعة لازم يكون 3-24 حرف إنكليزي أو رقم أو _.' });
      const groups = database.collection('community_groups');
      const doc = {
        name, username, creatorId: userId, creatorName: p.name, creatorUsername: p.username,
        membersCount: 1, createdAt: new Date()
      };
      let inserted;
      try { inserted = await groups.insertOne(doc); }
      catch (e) { if (e.code === 11000) return res.status(409).json({ error: 'يوزر هذه المجموعة مستخدم، اختار يوزر ثاني.' }); throw e; }
      const groupId = inserted.insertedId;
      await database.collection('community_group_members').insertOne({ groupId, userId, pinned: false, isCreator: true, joinedAt: new Date() });
      res.json({ ok: true, group: publicGroup({ ...doc, _id: groupId }, { pinned: false, isCreator: true }) });
    } catch (e) { fail(res, e); }
  });

  // عرض المجموعات المنشأة من جميع الطلاب، مع حالة انضمام الطالب الحالي.
  app.get('/api/community/groups', async (req, res) => {
    try {
      const userId = identity(req, res); if (!userId) return;
      const database = await db();
      if (!await profile(database, userId)) return res.status(403).json({ error: 'أنشئ حسابك في مجتمع دَرسي أولاً.' });
      const list = await database.collection('community_groups').find({}).sort({ createdAt: -1 }).limit(100).toArray();
      const ids = list.map(g => g._id);
      const memberships = ids.length ? await database.collection('community_group_members').find({ groupId: { $in: ids }, userId }).toArray() : [];
      const byGroup = new Map(memberships.map(m => [String(m.groupId), m]));
      res.set('Cache-Control', 'no-store');
      res.json(list.map(g => publicGroup(g, byGroup.get(String(g._id)))));
    } catch (e) { fail(res, e); }
  });

  app.post('/api/community/groups/join', async (req, res) => {
    try {
      const userId = identity(req, res); if (!userId) return;
      if (!validId(req.body.groupId)) return res.status(400).json({ error: 'المجموعة غير صحيحة.' });
      const database = await db(), groupId = new ObjectId(req.body.groupId);
      if (!await profile(database, userId)) return res.status(403).json({ error: 'أنشئ حسابك أولاً.' });
      const group = await database.collection('community_groups').findOne({ _id: groupId });
      if (!group) return res.status(404).json({ error: 'هذه المجموعة لم تعد موجودة.' });
      try {
        await database.collection('community_group_members').insertOne({ groupId, userId, pinned: false, isCreator: false, joinedAt: new Date() });
        await database.collection('community_groups').updateOne({ _id: groupId }, { $inc: { membersCount: 1 } });
      } catch (e) { if (e.code !== 11000) throw e; }
      const m = await member(database, groupId, userId);
      res.json({ ok: true, joined: true, pinned: !!(m && m.pinned) });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/community/groups/leave', async (req, res) => {
    try {
      const userId = identity(req, res); if (!userId) return;
      if (!validId(req.body.groupId)) return res.status(400).json({ error: 'المجموعة غير صحيحة.' });
      const database = await db(), groupId = new ObjectId(req.body.groupId);
      const result = await database.collection('community_group_members').deleteOne({ groupId, userId });
      if (result.deletedCount) await database.collection('community_groups').updateOne({ _id: groupId }, { $inc: { membersCount: -1 } });
      res.json({ ok: true, left: !!result.deletedCount });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/community/groups/pin', async (req, res) => {
    try {
      const userId = identity(req, res); if (!userId) return;
      if (!validId(req.body.groupId)) return res.status(400).json({ error: 'المجموعة غير صحيحة.' });
      const database = await db(), groupId = new ObjectId(req.body.groupId);
      const pinned = !!req.body.pinned;
      const result = await database.collection('community_group_members').updateOne({ groupId, userId }, { $set: { pinned } });
      if (!result.matchedCount) return res.status(403).json({ error: 'انضم للمجموعة أولاً حتى تثبتها.' });
      res.json({ ok: true, pinned });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/community/groups/:id/messages', async (req, res) => {
    try {
      const userId = identity(req, res); if (!userId) return;
      if (!validId(req.params.id)) return res.status(404).json({ error: 'المجموعة غير موجودة.' });
      const database = await db(), groupId = new ObjectId(req.params.id);
      if (!await member(database, groupId, userId)) return res.status(403).json({ error: 'انضم للمجموعة حتى تشوف المحادثة.' });
      const rows = await database.collection('community_group_messages').find({ groupId }).sort({ createdAt: -1 }).limit(80).toArray();
      res.set('Cache-Control', 'no-store');
      res.json(rows.reverse().map(m => ({ id: String(m._id), author: m.author, username: m.username, text: m.text, mine: m.userId === userId, createdAt: m.createdAt })));
    } catch (e) { fail(res, e); }
  });

  app.post('/api/community/groups/message', async (req, res) => {
    try {
      const userId = identity(req, res); if (!userId) return;
      if (!validId(req.body.groupId)) return res.status(400).json({ error: 'المجموعة غير صحيحة.' });
      const text = clean(req.body.text, 1200);
      if (!text) return res.status(400).json({ error: 'اكتب رسالتك أولاً.' });
      const database = await db(), groupId = new ObjectId(req.body.groupId);
      const p = await profile(database, userId);
      if (!p) return res.status(403).json({ error: 'أنشئ حسابك أولاً.' });
      if (!await member(database, groupId, userId)) return res.status(403).json({ error: 'انضم للمجموعة حتى تراسل أعضاءها.' });
      const doc = { groupId, userId, author: p.name, username: p.username, text, createdAt: new Date() };
      const result = await database.collection('community_group_messages').insertOne(doc);
      res.json({ ok: true, message: { id: String(result.insertedId), author: doc.author, username: doc.username, text, mine: true, createdAt: doc.createdAt } });
    } catch (e) { fail(res, e); }
  });
};
