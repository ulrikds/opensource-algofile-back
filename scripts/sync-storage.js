require('dotenv').config();
const mongoose = require('mongoose');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const crypto = require('crypto');

const s3 = new S3Client({
  endpoint: process.env.FILEBASE_ENDPOINT || 'https://s3.filebase.io',
  region: 'auto',
  credentials: {
    accessKeyId: process.env.FILEBASE_ACCESS_KEY_ID,
    secretAccessKey: process.env.FILEBASE_SECRET_ACCESS_KEY
  },
  forcePathStyle: true
});

function getUserHash(userId) {
  return crypto.createHash('sha256').update(userId).digest('hex').substring(0, 12);
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  const bucketName = 'algofile-yourbucket-25gb-zl8ii';
  const bucket = await db.collection('buckets').findOne({ name: bucketName });
  if (!bucket) {
    console.error('Bucket not found');
    process.exit(1);
  }

  const ownerId = bucket.owner.toString();
  const userHash = getUserHash(ownerId);
  const prefix = bucketName + '-' + userHash + '/';
  const s3Bucket = 'algofile-bucket-custom';

  console.log('Scanning S3 prefix:', prefix);
  let continuationToken = undefined;
  const s3Keys = new Set();
  let totalS3Bytes = 0;
  let s3FileCount = 0;

  do {
    const listRes = await s3.send(new ListObjectsV2Command({
      Bucket: s3Bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken
    }));
    if (listRes.Contents) {
      for (const obj of listRes.Contents) {
        if (!obj.Key || obj.Key.endsWith('/')) continue;
        s3Keys.add(obj.Key);
        s3FileCount++;
        totalS3Bytes += obj.Size || 0;
      }
    }
    continuationToken = listRes.NextContinuationToken;
  } while (continuationToken);

  console.log('S3 Active Files:', s3FileCount, 'Total Bytes:', totalS3Bytes, '(' + (totalS3Bytes / 1024 / 1024).toFixed(2) + ' MB)');

  // Clean importedcids
  const userObjId = bucket.owner;
  const importedDocs = await db.collection('importedcids').find({ bucketName, owner: userObjId }).toArray();
  const orphanedImportedIds = [];
  for (const doc of importedDocs) {
    const directKey = doc.s3Key;
    const byFileId = doc.fileId ? prefix + doc.fileId : null;
    const byCid = doc.cid ? prefix + doc.cid : null;
    const byFolderCid = doc.folder && doc.cid ? prefix + doc.folder + '/' + doc.cid : null;

    const exists = (directKey && s3Keys.has(directKey)) ||
                   (byFileId && s3Keys.has(byFileId)) ||
                   (byFolderCid && s3Keys.has(byFolderCid)) ||
                   (byCid && s3Keys.has(byCid));
    if (!exists) {
      orphanedImportedIds.push(doc._id);
    }
  }

  console.log('Orphaned importedcids found:', orphanedImportedIds.length);
  if (orphanedImportedIds.length > 0) {
    const resDel = await db.collection('importedcids').deleteMany({ _id: { $in: orphanedImportedIds } });
    console.log('Deleted orphaned importedcids:', resDel.deletedCount);
  }

  // Clean pinnedcids
  const pinnedDocs = await db.collection('pinnedcids').find({ bucketName, owner: userObjId }).toArray();
  const orphanedPinnedIds = [];
  for (const doc of pinnedDocs) {
    const byFileId = doc.fileId ? prefix + doc.fileId : null;
    const byCid = doc.cid ? prefix + doc.cid : null;

    const exists = (byFileId && s3Keys.has(byFileId)) || (byCid && s3Keys.has(byCid));
    if (!exists) {
      orphanedPinnedIds.push(doc._id);
    }
  }

  console.log('Orphaned pinnedcids found:', orphanedPinnedIds.length);
  if (orphanedPinnedIds.length > 0) {
    const resDel = await db.collection('pinnedcids').deleteMany({ _id: { $in: orphanedPinnedIds } });
    console.log('Deleted orphaned pinnedcids:', resDel.deletedCount);
  }

  // Update bucket usedSizeBytes
  await db.collection('buckets').updateOne(
    { _id: bucket._id },
    { $set: { usedSizeBytes: totalS3Bytes } }
  );
  console.log('Updated bucket usedSizeBytes to:', totalS3Bytes);

  // Recalculate user storage
  const pinnedAgg = await db.collection('pinnedcids').aggregate([
    { $match: { owner: userObjId } },
    { $group: { _id: null, totalBytes: { $sum: '$sizeBytes' } } }
  ]).toArray();
  const pinnedSize = pinnedAgg[0]?.totalBytes || 0;

  const importedAgg = await db.collection('importedcids').aggregate([
    { $match: { owner: userObjId } },
    { $group: { _id: null, totalBytes: { $sum: '$sizeBytes' } } }
  ]).toArray();
  const importedSize = importedAgg[0]?.totalBytes || 0;

  const userTotalUsed = Math.max(pinnedSize, importedSize);
  await db.collection('users').updateOne(
    { _id: userObjId },
    { $set: { usedStorageBytes: userTotalUsed } }
  );
  console.log('Updated user usedStorageBytes to:', userTotalUsed, '(' + (userTotalUsed / 1024 / 1024).toFixed(2) + ' MB)');

  console.log('Sync complete!');
  process.exit(0);
})();
