// الرسائل الخاصة بين حسابات مجتمع دَرسي مع حالة الاتصال والحظر
module.exports = function privateMessagesAPI(app, db) {
  db().then(async d => {
    await d.collection('private_messages').createIndex({ fromId: 1, toId: 1, createdAt: -1 });
    await d.collection('private_message_blocks').createIndex({ ownerId: 1, blockedId: 1 }, { unique: true });
    await d.collection('private_message_pins').createIndex({ ownerId: 1, otherId: 1 }, { unique: true });
    await d.collection('private_message_reads').createIndex({ ownerId: 1, otherId: 1 }, { unique: true });
  }).catch(e => console.error('Private messages indexes:', e.message));

  const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  function identity(req, res) {
    const id = clean(req.body?.deviceId || req.query.deviceId, 80);
    if (!/^[a-zA-Z0-9_-]{24,80}$/.test(id)) {
      res.status(401).json({ error: 'أنشئ حسابك في مجتمع دَرسي أولاً.' });
      return null;
    }
    return id;
  }
  async function me(d, id) { return d.collection('community_profiles').findOne({ _id: id }); }
  async function getOther(d, username) {
    return d.collection('community_profiles').findOne({ username: clean(username, 24).replace(/^@/, '').toLowerCase() });
  }
  async function blockState(d, a, b) {
    const [byMe, byThem] = await Promise.all([
      d.collection('private_message_blocks').findOne({ ownerId: a, blockedId: b }),
      d.collection('private_message_blocks').findOne({ ownerId: b, blockedId: a })
    ]);
    return { blockedByMe: !!byMe, blockedMe: !!byThem };
  }
  function userView(p) {
    return {
      name: clean(p.name || p.username, 60),
      username: clean(p.username, 24),
      verified: String(p.username || '').toLowerCase() === 'aaa',
      designer: String(p.username || '').toLowerCase() === 'aaa'
    };
  }
  function presenceView(row) {
    const lastSeen = row?.lastSeen ? new Date(row.lastSeen) : null;
    const online = !!(lastSeen && Date.now() - lastSeen.getTime() <= 90000);
    return { online, lastSeen: lastSeen && !isNaN(lastSeen.getTime()) ? lastSeen.toISOString() : null };
  }
  async function presenceFor(d, ids) {
    if (!ids.length) return new Map();
    const rows = await d.collection('private_message_presence').find({ _id: { $in: ids } }).toArray();
    return new Map(rows.map(row => [row._id, presenceView(row)]));
  }

  // تحديث آخر ظهور للحساب الحالي. ترسل الواجهة نبضة كل 30 ثانية أثناء استخدام القسم.
  app.post('/api/community/private/presence', async (req, res) => {
    try {
      const id = identity(req, res); if (!id) return;
      const d = await db();
      if (!await me(d, id)) return res.status(403).json({ error: 'أنشئ حسابك أولاً.' });
      const now = new Date();
      await d.collection('private_message_presence').updateOne(
        { _id: id }, { $set: { lastSeen: now } }, { upsert: true }
      );
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, presence: { online: true, lastSeen: now.toISOString() } });
    } catch (e) {
      console.error('Private presence:', e);
      res.status(500).json({ error: 'تعذر تحديث حالة الظهور.' });
    }
  });

  app.get('/api/community/private/users', async (req, res) => {
    try {
      const id = identity(req, res); if (!id) return;
      const d = await db();
      if (!await me(d, id)) return res.status(403).json({ error: 'أنشئ حسابك أولاً.' });
      const q = clean(req.query.q, 30).replace(/^@/, '').toLowerCase();
      if (q.length < 2) return res.json([]);
      const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rows = await d.collection('community_profiles')
        .find({ _id: { $ne: id }, username: { $regex: '^' + safe, $options: 'i' } })
        .limit(12).toArray();
      res.set('Cache-Control', 'no-store');
      res.json(rows.map(userView));
    } catch (e) {
      console.error(e); res.status(500).json({ error: 'تعذر البحث عن الطلاب.' });
    }
  });

  app.get('/api/community/private/conversations', async (req, res) => {
    try {
      const id = identity(req, res); if (!id) return;
      const d = await db();
      if (!await me(d, id)) return res.status(403).json({ error: 'أنشئ حسابك أولاً.' });
      const msgs = await d.collection('private_messages')
        .find({ $or: [{ fromId: id }, { toId: id }], hiddenFor: { $ne: id } })
        .sort({ createdAt: -1 }).limit(500).toArray();
      const map = new Map();
      for (const m of msgs) {
        const other = m.fromId === id ? m.toId : m.fromId;
        if (!map.has(other)) map.set(other, m);
      }
      const ids = [...map.keys()];
      const [profiles, pins, blockedRows, presences, reads] = await Promise.all([
        ids.length ? d.collection('community_profiles').find({ _id: { $in: ids } }).toArray() : [],
        ids.length ? d.collection('private_message_pins').find({ ownerId: id, otherId: { $in: ids } }).toArray() : [],
        ids.length ? d.collection('private_message_blocks').find({ ownerId: id, blockedId: { $in: ids } }).toArray() : [],
        presenceFor(d, ids),
        ids.length ? d.collection('private_message_reads').find({ ownerId: id, otherId: { $in: ids } }).toArray() : []
      ]);
      const byId = new Map(profiles.map(p => [p._id, p]));
      const pinSet = new Set(pins.map(p => p.otherId));
      const blockSet = new Set(blockedRows.map(x => x.blockedId));
      const readMap = new Map(reads.map(x => [x.otherId, x.lastReadAt]));
      const unreadCounts = new Map();
      await Promise.all(ids.map(async otherId => {
        const lastReadAt = readMap.get(otherId) || new Date(0);
        const count = await d.collection('private_messages').countDocuments({ fromId: otherId, toId: id, createdAt: { $gt: lastReadAt }, hiddenFor: { $ne: id } });
        unreadCounts.set(otherId, count);
      }));
      res.set('Cache-Control', 'no-store');
      res.json(ids.filter(x => byId.has(x)).map(x => ({
        id: x, ...userView(byId.get(x)), lastText: map.get(x).text,
        unreadCount: unreadCounts.get(x) || 0,
        pinned: pinSet.has(x), blocked: blockSet.has(x), presence: presences.get(x) || { online: false, lastSeen: null },
        createdAt: map.get(x).createdAt
      })).sort((a, b) => Number(b.pinned) - Number(a.pinned) || new Date(b.createdAt) - new Date(a.createdAt)));
    } catch (e) {
      console.error(e); res.status(500).json({ error: 'تعذر تحميل الرسائل.' });
    }
  });

  // ملخص الإشعارات والرسائل غير المقروءة للحساب الحالي.
  app.get('/api/community/private/notifications', async (req, res) => {
    try {
      const id = identity(req, res); if (!id) return;
      const d = await db();
      if (!await me(d, id)) return res.status(403).json({ error: 'أنشئ حسابك أولاً.' });
      const reads = await d.collection('private_message_reads').find({ ownerId: id }).toArray();
      const readMap = new Map(reads.map(x => [x.otherId, x.lastReadAt || new Date(0)]));
      const senders = await d.collection('private_messages').distinct('fromId', { toId: id, hiddenFor: { $ne: id } });
      const items = [];
      for (const senderId of senders) {
        const count = await d.collection('private_messages').countDocuments({ fromId: senderId, toId: id, createdAt: { $gt: readMap.get(senderId) || new Date(0) }, hiddenFor: { $ne: id } });
        if (count) {
          const profile = await me(d, senderId);
          if (profile) items.push({ ...userView(profile), unreadCount: count });
        }
      }
      res.set('Cache-Control', 'no-store');
      res.json({ total: items.reduce((n, x) => n + x.unreadCount, 0), items });
    } catch (e) { console.error('Private notifications:', e); res.status(500).json({ error: 'تعذر تحميل الإشعارات.' }); }
  });

  app.get('/api/community/private/:username', async (req, res) => {
    try {
      const id = identity(req, res); if (!id) return;
      const d = await db(), p = await me(d, id), other = await getOther(d, req.params.username);
      if (!p || !other) return res.status(404).json({ error: 'الطالب غير موجود.' });
      if (other._id === id) return res.status(400).json({ error: 'هذا حسابك أنت.' });
      await d.collection('private_message_reads').updateOne(
        { ownerId: id, otherId: other._id },
        { $set: { ownerId: id, otherId: other._id, lastReadAt: new Date() } }, { upsert: true }
      );
      const [rows, presenceRow, blocks, otherRead] = await Promise.all([
        d.collection('private_messages').find({
          $or: [{ fromId: id, toId: other._id }, { fromId: other._id, toId: id }],
          hiddenFor: { $ne: id }
        }).sort({ createdAt: -1 }).limit(100).toArray(),
        d.collection('private_message_presence').findOne({ _id: other._id }),
        blockState(d, id, other._id),
        d.collection('private_message_reads').findOne({ ownerId: other._id, otherId: id })
      ]);
      res.set('Cache-Control', 'no-store');
      res.json({
        user: userView(other), presence: presenceView(presenceRow), ...blocks,
        messages: rows.reverse().map(m => ({ id: String(m._id), text: m.text, mine: m.fromId === id, seen: m.fromId === id && !!(otherRead && otherRead.lastReadAt && new Date(otherRead.lastReadAt).getTime() >= new Date(m.createdAt).getTime()), createdAt: m.createdAt }))
      });
    } catch (e) {
      console.error(e); res.status(500).json({ error: 'تعذر فتح المحادثة.' });
    }
  });

  app.post('/api/community/private/send', async (req, res) => {
    try {
      const id = identity(req, res); if (!id) return;
      const d = await db(), p = await me(d, id), to = await getOther(d, req.body.username);
      const text = clean(req.body.text, 2000);
      if (!p || !to) return res.status(404).json({ error: 'الطالب غير موجود.' });
      if (to._id === id) return res.status(400).json({ error: 'ما تكدر تراسل نفسك.' });
      if (!text) return res.status(400).json({ error: 'اكتب رسالتك أولاً.' });
      const blocks = await blockState(d, id, to._id);
      if (blocks.blockedMe) return res.status(403).json({ error: 'هذا الشخص قام بحظرك.' });
      if (blocks.blockedByMe) return res.status(403).json({ error: 'أنت حظرت هذا الشخص. ألغِ الحظر حتى تتمكن من مراسلته.' });
      const doc = { fromId: id, toId: to._id, text, createdAt: new Date(), hiddenFor: [] };
      const r = await d.collection('private_messages').insertOne(doc);
      res.json({ ok: true, message: { id: String(r.insertedId), text, mine: true, createdAt: doc.createdAt } });
    } catch (e) {
      console.error(e); res.status(500).json({ error: 'تعذر إرسال الرسالة.' });
    }
  });

  app.post('/api/community/private/pin', async (req, res) => {
    try {
      const id = identity(req, res); if (!id) return;
      const d = await db(), other = await getOther(d, req.body.username);
      if (!other || other._id === id) return res.status(404).json({ error: 'الطالب غير موجود.' });
      if (req.body.pinned) await d.collection('private_message_pins').updateOne(
        { ownerId: id, otherId: other._id },
        { $set: { ownerId: id, otherId: other._id, createdAt: new Date() } }, { upsert: true }
      );
      else await d.collection('private_message_pins').deleteOne({ ownerId: id, otherId: other._id });
      res.json({ ok: true, pinned: !!req.body.pinned });
    } catch (e) { console.error(e); res.status(500).json({ error: 'تعذر تثبيت المحادثة.' }); }
  });

  app.post('/api/community/private/delete', async (req, res) => {
    try {
      const id = identity(req, res); if (!id) return;
      const d = await db(), other = await getOther(d, req.body.username);
      if (!other) return res.status(404).json({ error: 'الطالب غير موجود.' });
      await d.collection('private_messages').updateMany(
        { $or: [{ fromId: id, toId: other._id }, { fromId: other._id, toId: id }] },
        { $addToSet: { hiddenFor: id } }
      );
      await d.collection('private_message_pins').deleteOne({ ownerId: id, otherId: other._id });
      res.json({ ok: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'تعذر حذف المحادثة.' }); }
  });

  app.post('/api/community/private/block', async (req, res) => {
    try {
      const id = identity(req, res); if (!id) return;
      const d = await db(), other = await getOther(d, req.body.username);
      if (!other || other._id === id) return res.status(404).json({ error: 'الطالب غير موجود.' });
      const shouldBlock = req.body.blocked === true;
      if (shouldBlock) await d.collection('private_message_blocks').updateOne(
        { ownerId: id, blockedId: other._id },
        { $set: { ownerId: id, blockedId: other._id, createdAt: new Date() } }, { upsert: true }
      );
      else await d.collection('private_message_blocks').deleteOne({ ownerId: id, blockedId: other._id });
      const blocks = await blockState(d, id, other._id);
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, ...blocks });
    } catch (e) { console.error(e); res.status(500).json({ error: 'تعذر تحديث الحظر.' }); }
  });
};
