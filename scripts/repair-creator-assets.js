const mongoose = require('mongoose');
const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({
  endpoint: 'https://s3.filebase.io',
  region: 'us-east-1',
  credentials: {
    accessKeyId: 'ABE39E4A3DFADC246840',
    secretAccessKey: 'eV8a0Ba5O1R7RLzu6HOPbHqpKmsGvwnRrHPhmCDB',
  },
});

(async () => {
  await mongoose.connect('mongodb://ulrikmongo:r4pdtk3j@ac-kk0grz2-shard-00-00.sk4khxs.mongodb.net:27017,ac-kk0grz2-shard-00-01.sk4khxs.mongodb.net:27017,ac-kk0grz2-shard-00-02.sk4khxs.mongodb.net:27017/algofile?ssl=true&replicaSet=atlas-sb5wl6-shard-0&authSource=admin');
  const db = mongoose.connection.db;

  const items = await db.collection('importedcids').find({ folder: 'creator-assets-6b7naw' }).toArray();
  console.log('Total items in creator-assets-6b7naw:', items.length);

  const fetchBuffer = async (cid) => {
    const urls = [
      'https://algofile.myfilebase.com/ipfs/' + cid,
      'https://algofile2.myfilebase.com/ipfs/' + cid,
      'https://algofile3.myfilebase.com/ipfs/' + cid,
      'https://ipfs.algonode.xyz/ipfs/' + cid,
      'https://4160.nodely.dev/ipfs/' + cid,
      'https://dweb.link/ipfs/' + cid,
    ];
    const tryUrl = async (u) => {
      const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(u + ' ' + r.status);
      const ab = await r.arrayBuffer();
      const buf = Buffer.from(ab);
      if (!buf.length) throw new Error('empty');
      return { buf, ct: r.headers.get('content-type') || 'application/octet-stream' };
    };
    return await Promise.any(urls.map(tryUrl));
  };

  let fixed = 0;
  for (const item of items) {
    let needsUpload = false;
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: 'algofile-bucket-custom', Key: item.s3Key }));
      if (head.ContentLength > 0 && head.Metadata?.cid === item.cid) {
        console.log('OK already:', item.cid, head.ContentLength, 'bytes');
      } else {
        needsUpload = true;
      }
    } catch (_) {
      needsUpload = true;
    }

    if (needsUpload) {
      console.log('Repairing CID:', item.cid, item.name);
      try {
        const fetched = await fetchBuffer(item.cid);
        await s3.send(new PutObjectCommand({
          Bucket: 'algofile-bucket-custom',
          Key: item.s3Key,
          Body: fetched.buf,
          ContentType: fetched.ct,
          Metadata: {
            cid: item.cid,
            'x-amz-meta-cid': item.cid,
            'x-amz-meta-name': item.name || item.cid,
            'x-amz-meta-original-size': String(fetched.buf.length),
          },
        }));
        await db.collection('importedcids').updateOne(
          { _id: item._id },
          { $set: { sizeBytes: fetched.buf.length, mimeType: fetched.ct, status: 'pinned' } }
        );
        fixed++;
        console.log('-> Successfully fixed and hosted:', item.cid, fetched.buf.length, 'bytes');
      } catch(err) {
        console.warn('-> Failed to repair:', item.cid, err.message);
      }
    }
  }

  console.log('Repair completed. Fixed', fixed, 'items.');
  process.exit(0);
})();
