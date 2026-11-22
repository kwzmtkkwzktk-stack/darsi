const crypto = require('crypto');
const { ObjectId, Binary } = require('mongodb');

module.exports = function communityAPI(app, db) {
  db().then(async database => { await database.collection('community_profiles').createIndex({username:1},{unique:true}); await database.collection('community_views').createIndex({postId:1,viewer:1},{unique:true}); await database.collection('community_likes').createIndex({postId:1,deviceId:1},{unique:true}); }).catch(e=>console.error('Community indexes:',e.message));
  const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  const fail = (res, e) => { console.error('Community API:', e.message); res.status(500).json({error:'حدث خطأ بالخادم'}); };
  function identity(req,res) {
    const id=clean(req.body?.deviceId || req.query.deviceId,80);
    if(!/^[a-zA-Z0-9_-]{24,80}$/.test(id)){res.status(401).json({error:'أنشئ حسابك أولاً'});return null;}
    return id;
  }
  app.post('/api/community/profile', async (req,res) => {
    try {
      const id=identity(req,res); if(!id)return;
      const c=(await db()).collection('community_profiles');
      let p=await c.findOne({_id:id});
      if(req.body.username){
        const username=clean(req.body.username,24).toLowerCase().replace(/[^a-z0-9_]/g,'');
        const name=clean(req.body.name,40);
        if(!name)return res.status(400).json({error:'اكتب اسمك الظاهر للطلاب'});
        if(!/^[a-z0-9_]{3,24}$/.test(username))return res.status(400).json({error:'اليوزر لازم يكون 3-24 حرف إنكليزي أو رقم أو _'});
        if(p)return res.status(409).json({error:'لديك يوزر منشأ مسبقاً'});
        try{p={_id:id,username,name,createdAt:new Date()};await c.insertOne(p)}catch(e){if(e.code===11000)return res.status(409).json({error:'هذا اليوزر مستخدم، اختار غيره'});throw e}
      }
      if(!p)return res.json({profile:null,needsUsername:true});
      res.json({profile:{username:p.username,name:p.name}});
    }catch(e){fail(res,e)}
  });
  app.get('/api/community/feed', async(req,res)=>{
    try {
      const code=identity(req,res); if(!code)return;
      const dbx=await db(), p=await dbx.collection('community_profiles').findOne({_id:code});
      if(!p) return res.status(403).json({error:'أنشئ يوزرك أولاً'});
      const list=await dbx.collection('community_posts').find({}).sort({createdAt:-1}).limit(60).toArray();
      const ids=list.map(x=>x._id);
      const likes=await dbx.collection('community_likes').find({postId:{$in:ids},deviceId:code}).project({postId:1}).toArray();
      res.set('Cache-Control','no-store');
      res.json(list.map(x=>({id:String(x._id),text:x.text,author:x.author,username:x.username,image:x.imageId?'/api/community/image/'+x.imageId:null,createdAt:x.createdAt,views:x.views||0,likes:x.likes||0,comments:x.comments||0,liked:likes.some(l=>String(l.postId)===String(x._id))})));
    }catch(e){fail(res,e)}
  });
  app.post('/api/community/post', async(req,res)=>{
    try {
      const code=identity(req,res); if(!code)return;
      const dbx=await db(), p=await dbx.collection('community_profiles').findOne({_id:code});
      if(!p)return res.status(403).json({error:'أنشئ يوزرك أولاً'});
      const text=clean(req.body.text,2000), data=String(req.body.image||'');
      if(!text && !data)return res.status(400).json({error:'اكتب منشور أو أرفق صورة'});
      let imageId=null;
      if(data){const m=/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(data);if(!m)return res.status(400).json({error:'صيغة الصورة غير مدعومة'});const buf=Buffer.from(m[2],'base64');if(buf.length>1200000)return res.status(413).json({error:'الصورة أكبر من 1.2 ميغابايت'});const r=await dbx.collection('community_images').insertOne({type:'image/'+m[1],data:new Binary(buf),createdAt:new Date()});imageId=String(r.insertedId);}
      const r=await dbx.collection('community_posts').insertOne({text,author:p.name,username:p.username,deviceId:code,imageId,createdAt:new Date(),views:0,likes:0,comments:0});
      res.json({ok:true,id:String(r.insertedId)});
    }catch(e){fail(res,e)}
  });
  app.post('/api/community/comment', async(req,res)=>{
    try{const code=identity(req,res);if(!code)return;const id=clean(req.body.postId,30),text=clean(req.body.text,700);if(!ObjectId.isValid(id)||!text)return res.status(400).json({error:'اكتب تعليقاً صحيحاً'});const dbx=await db(),p=await dbx.collection('community_profiles').findOne({_id:code});if(!p)return res.sendStatus(403);const r=await dbx.collection('community_comments').insertOne({postId:new ObjectId(id),deviceId:code,author:p.name,username:p.username,text,createdAt:new Date()});await dbx.collection('community_posts').updateOne({_id:new ObjectId(id)},{$inc:{comments:1}});res.json({ok:true,id:String(r.insertedId)});}catch(e){fail(res,e)}
  });
  app.get('/api/community/comments/:id',async(req,res)=>{try{if(!ObjectId.isValid(req.params.id))return res.sendStatus(404);const a=await(await db()).collection('community_comments').find({postId:new ObjectId(req.params.id)}).sort({createdAt:1}).limit(100).toArray();res.json(a.map(x=>({author:x.author,username:x.username,text:x.text,createdAt:x.createdAt})));}catch(e){fail(res,e)}});
  app.post('/api/community/like',async(req,res)=>{try{const code=identity(req,res);if(!code)return;const id=clean(req.body.postId,30);if(!ObjectId.isValid(id))return res.sendStatus(400);const dbx=await db(),likes=dbx.collection('community_likes'),key={postId:new ObjectId(id),deviceId:code};const old=await likes.findOne(key);if(old){await likes.deleteOne({_id:old._id});await dbx.collection('community_posts').updateOne({_id:key.postId},{$inc:{likes:-1}});return res.json({liked:false})}await likes.insertOne({...key,createdAt:new Date()});await dbx.collection('community_posts').updateOne({_id:key.postId},{$inc:{likes:1}});res.json({liked:true});}catch(e){fail(res,e)}});
  app.post('/api/community/view',async(req,res)=>{try{const id=clean(req.body.postId,30),viewer=clean(req.body.viewer,100);if(!ObjectId.isValid(id)||!/^[a-zA-Z0-9_-]{12,100}$/.test(viewer))return res.sendStatus(400);const dbx=await db(),views=dbx.collection('community_views'),key={postId:new ObjectId(id),viewer};try{await views.insertOne({...key,createdAt:new Date()});await dbx.collection('community_posts').updateOne({_id:key.postId},{$inc:{views:1}});res.json({counted:true})}catch(e){if(e.code===11000)return res.json({counted:false});throw e}}catch(e){fail(res,e)}});
  app.post('/api/community/share',async(req,res)=>{try{const code=identity(req,res);if(!code)return;const id=clean(req.body.postId,30);if(!ObjectId.isValid(id))return res.sendStatus(400);await(await db()).collection('community_posts').updateOne({_id:new ObjectId(id)},{$inc:{shares:1}});res.json({ok:true})}catch(e){fail(res,e)}});
  app.get('/api/community/image/:id',async(req,res)=>{try{if(!ObjectId.isValid(req.params.id))return res.sendStatus(404);const x=await(await db()).collection('community_images').findOne({_id:new ObjectId(req.params.id)});if(!x)return res.sendStatus(404);res.set({'Content-Type':x.type,'Cache-Control':'public,max-age=86400','X-Content-Type-Options':'nosniff'});res.send(Buffer.from(x.data.buffer));}catch(e){res.sendStatus(500)}});
};
