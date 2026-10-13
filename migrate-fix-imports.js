const mongoose = require('mongoose');
const {
  S3Client,
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');
require('dotenv').config();

const s3 = new S3Client({
  endpoint: 'https://s3.filebase.io',
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.FILEBASE_ACCESS_KEY_ID,
    secretAccessKey: process.env.FILEBASE_SECRET_ACCESS_KEY,
  },
});

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB');

  const s3Bucket = 'algofile-bucket-custom';
  const targetBucketName = 'algofile-yourbucket-25gb-zl8ii';

  const importedColl = mongoose.connection.db.collection('importedcids');
  const pinnedColl = mongoose.connection.db.collection('pinnedcids');

  const records = await importedColl
    .find({ bucketName: targetBucketName })
    .toArray();
  console.log(`Found ${records.length} records to process for ${targetBucketName}.`);

  let processed = 0;
  let copiedCount = 0;
  let deletedOldCount = 0;
  let deletedRootCount = 0;

  const concurrency = 20;
  for (let i = 0; i < records.length; i += concurrency) {
    const chunk = records.slice(i, i + concurrency);

    await Promise.all(
      chunk.map(async (record) => {
        const { cid, s3Key, folder, name } = record;
        if (!cid) return;

        const cleanFolder = folder || 'creator-assets-kxqpiv';
        const userPrefix = 'algofile-yourbucket-25gb-zl8ii-8f496d3101dc/';
        const destKey = `${userPrefix}${cleanFolder}/${cid}`;
        const newFileId = `${cleanFolder}/${cid}`;

        // 1. Ensure object exists at destKey
        let destExists = false;
        try {
          const headDest = await s3.send(
            new HeadObjectCommand({ Bucket: s3Bucket, Key: destKey }),
          );
          if (headDest.ContentLength !== undefined) {
            destExists = true;
          }
        } catch (_) {}

        if (!destExists) {
          // Copy from old s3Key or from root cid
          let copySource = '';
          if (s3Key && s3Key !== destKey) {
            copySource = `${s3Bucket}/${encodeURIComponent(s3Key)}`;
          } else {
            copySource = `${s3Bucket}/${encodeURIComponent(cid)}`;
          }

          try {
            await s3.send(
              new CopyObjectCommand({
                Bucket: s3Bucket,
                CopySource: copySource,
                Key: destKey,
              }),
            );
            copiedCount++;
            destExists = true;
          } catch (copyErr) {
            // Fallback: try copying from root cid if s3Key failed
            try {
              await s3.send(
                new CopyObjectCommand({
                  Bucket: s3Bucket,
                  CopySource: `${s3Bucket}/${encodeURIComponent(cid)}`,
                  Key: destKey,
                }),
              );
              copiedCount++;
              destExists = true;
            } catch (err2) {
              console.warn(`Could not copy to ${destKey}:`, err2.message);
            }
          }
        }

        // 2. If destExists, delete old s3Key if different
        if (destExists && s3Key && s3Key !== destKey) {
          try {
            await s3.send(
              new DeleteObjectCommand({ Bucket: s3Bucket, Key: s3Key }),
            );
            deletedOldCount++;
          } catch (_) {}
        }

        // 3. Delete duplicate root CID object from algofile-bucket-custom
        try {
          await s3.send(new DeleteObjectCommand({ Bucket: s3Bucket, Key: cid }));
          deletedRootCount++;
        } catch (_) {}

        // 4. Update MongoDB records
        await importedColl.updateOne(
          { _id: record._id },
          {
            $set: {
              fileId: newFileId,
              s3Key: destKey,
            },
          },
        );

        await pinnedColl.updateOne(
          { cid, bucketName: targetBucketName },
          {
            $set: {
              fileId: newFileId,
            },
          },
        );

        processed++;
      }),
    );

    if (processed % 100 === 0 || processed === records.length) {
      console.log(`Progress: ${processed}/${records.length} processed (Copied: ${copiedCount}, Deleted Old: ${deletedOldCount}, Deleted Root: ${deletedRootCount})`);
    }
  }

  console.log(`Migration completed successfully! Total processed: ${processed}`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
