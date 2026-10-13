import {
  Injectable,
  BadRequestException,
} from '@nestjs/common';
import {
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand,
  GetObjectAclCommand,
  ListObjectsCommand,
} from '@aws-sdk/client-s3';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Bucket, BucketDocument } from '../schemas/bucket.schema';
import {
  Collection,
  CollectionDocument,
} from '../../collections/schemas/collection.schema';
import { PinnedCid, PinnedCidDocument } from '../schemas/pinned-cid.schema';
import { ImportedCid, ImportedCidDocument } from '../schemas/imported-cid.schema';
import { FilebaseClientService, extractCidFromMetadata } from './filebase-client.service';
import { FilebasePinningService } from './filebase-pinning.service';

@Injectable()
export class FilebaseFileExplorerService {
  constructor(
    @InjectModel(Bucket.name)
    private readonly bucketModel: Model<BucketDocument>,
    @InjectModel(Collection.name)
    private readonly collectionModel: Model<CollectionDocument>,
    @InjectModel(PinnedCid.name)
    private readonly pinnedCidModel: Model<PinnedCidDocument>,
    @InjectModel(ImportedCid.name)
    private readonly importedCidModel: Model<ImportedCidDocument>,
    private readonly clientService: FilebaseClientService,
    private readonly pinningService: FilebasePinningService,
  ) {}

  /**
   * Retrieves file metadata (IPFS CID and actual size) using HeadObjectCommand with retries.
   */
  async getFileMetadata(
    userId: string,
    bucketName: string,
    key: string,
    maxRetries = 10,
    delayMs = 500,
  ): Promise<{ cid: string; sizeBytes: number }> {
    const { s3Bucket, s3Key } = await this.clientService.getS3Params(
      bucketName,
      userId,
      key,
    );

    const headCommand = new HeadObjectCommand({
      Bucket: s3Bucket,
      Key: s3Key,
    });

    let lastError: any = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const headResponse = await this.clientService.getS3Client().send(headCommand);
        const cid = extractCidFromMetadata(
          headResponse.Metadata,
          (headResponse.$metadata as any)?.httpHeaders,
        );

        if (cid) {
          return {
            cid,
            sizeBytes: headResponse.ContentLength || 0,
          };
        }
        lastError = new Error('IPFS CID was not returned in object metadata by Filebase.');
      } catch (error) {
        lastError = error;
      }

      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
      }
    }

    throw new BadRequestException(
      `Failed to retrieve file metadata from Filebase: ${lastError?.message || 'UnknownError'}`,
    );
  }

  /**
   * Retrieves the size of a file from Filebase S3 using HeadObject.
   */
  async getFileSize(
    userId: string,
    bucketName: string,
    key: string,
  ): Promise<number> {
    try {
      const { s3Bucket, s3Key } = await this.clientService.getS3Params(
        bucketName,
        userId,
        key,
      );
      const headCommand = new HeadObjectCommand({
        Bucket: s3Bucket,
        Key: s3Key,
      });
      const headResponse = await this.clientService.getS3Client().send(headCommand);
      return headResponse.ContentLength || 0;
    } catch (err) {
      console.warn(
        `Failed to retrieve file size for key ${key}: ${err.message}`,
      );
      return 0;
    }
  }

  /**
   * Lists files and folders inside a bucket for navigation, explorer, and file manager.
   */
  async listBucketFiles(
    userId: string,
    bucketName: string,
    limit: number = 50,
    continuationToken?: string,
    folder?: string,
  ) {
    const sanitizedName = bucketName.toLowerCase().trim();

    // 1. Verify access/ownership
    const bucket = await this.bucketModel
      .findOne({ name: sanitizedName })
      .exec();

    if (!bucket) {
      throw new BadRequestException(
        `Target bucket '${bucketName}' is not registered on the platform.`,
      );
    }

    const isFreeBucket = !bucket.owner;
    if (!isFreeBucket && bucket.owner?.toString() !== userId) {
      throw new BadRequestException(
        `Access denied: You do not own the bucket '${bucketName}'.`,
      );
    }

    const ownerId =
      bucket && bucket.owner
        ? (bucket.owner as any)?._id
          ? (bucket.owner as any)._id.toString()
          : bucket.owner.toString()
        : userId;
    const userHash = this.clientService.getUserHash(ownerId);
    const s3Bucket = 'algofile-bucket-custom';
    const userPrefix = `${sanitizedName}-${userHash}/`;
    const cleanFolder = (folder || '').replace(/^\/+|\/+$/g, '').trim();
    const folderPrefix = cleanFolder ? `${cleanFolder}/` : '';
    const prefix = `${userPrefix}${folderPrefix}`;
    const s3Client = this.clientService.getS3Client();

    // 2. Discover all folders in the bucket across S3 and MongoDB
    const allBucketFoldersSet = new Set<string>();

    try {
      // 2a. S3 Folder scan with Delimiter '/' and MaxKeys: 1000 under userPrefix
      let s3Truncated = true;
      let s3Token: string | undefined;
      let s3Loops = 0;
      while (s3Truncated && s3Loops < 5) {
        s3Loops++;
        const s3FolderRes = await s3Client.send(
          new ListObjectsV2Command({
            Bucket: s3Bucket,
            Prefix: userPrefix,
            Delimiter: '/',
            MaxKeys: 1000,
            ContinuationToken: s3Token,
          }),
        );
        if (s3FolderRes.CommonPrefixes) {
          for (const cp of s3FolderRes.CommonPrefixes) {
            if (cp.Prefix) {
              const relPath = cp.Prefix.startsWith(userPrefix)
                ? cp.Prefix.slice(userPrefix.length).replace(/\/$/, '')
                : cp.Prefix.replace(/\/$/, '');
              if (relPath) {
                allBucketFoldersSet.add(relPath);
              }
            }
          }
        }
        if (s3FolderRes.Contents) {
          for (const item of s3FolderRes.Contents) {
            if (item.Key && item.Key.endsWith('/')) {
              const relPath = item.Key.startsWith(userPrefix)
                ? item.Key.slice(userPrefix.length).replace(/\/$/, '')
                : item.Key.replace(/\/$/, '');
              if (relPath) {
                allBucketFoldersSet.add(relPath);
              }
            }
          }
        }
        s3Truncated = s3FolderRes.IsTruncated || false;
        s3Token = s3FolderRes.NextContinuationToken;
      }

      // 2b. If inside a folder, also query that subfolder in S3 to find immediate child folders
      if (cleanFolder) {
        try {
          const subRes = await s3Client.send(
            new ListObjectsV2Command({
              Bucket: s3Bucket,
              Prefix: prefix,
              Delimiter: '/',
              MaxKeys: 1000,
            }),
          );
          if (subRes.CommonPrefixes) {
            for (const cp of subRes.CommonPrefixes) {
              if (cp.Prefix) {
                const relPath = cp.Prefix.startsWith(userPrefix)
                  ? cp.Prefix.slice(userPrefix.length).replace(/\/$/, '')
                  : cp.Prefix.replace(/\/$/, '');
                if (relPath) {
                  allBucketFoldersSet.add(relPath);
                }
              }
            }
          }
          if (subRes.Contents) {
            for (const item of subRes.Contents) {
              if (item.Key && item.Key.endsWith('/')) {
                const relPath = item.Key.startsWith(userPrefix)
                  ? item.Key.slice(userPrefix.length).replace(/\/$/, '')
                  : item.Key.replace(/\/$/, '');
                if (relPath) {
                  allBucketFoldersSet.add(relPath);
                }
              }
            }
          }
        } catch (subErr) {
          console.warn('Subfolder S3 query error:', subErr.message);
        }
      }

      // 2c. Discover folders from MongoDB ImportedCids
      const ownerObjId = new Types.ObjectId(ownerId);
      const importedRecords = await this.importedCidModel
        .find({
          bucketName: { $regex: new RegExp(`^${sanitizedName}$`, 'i') },
          $or: [{ owner: ownerObjId as any }, { owner: ownerId as any }],
        })
        .select('folder fileId name')
        .lean()
        .exec();

      for (const imp of importedRecords) {
        if (imp.folder && typeof imp.folder === 'string') {
          const cleanF = imp.folder.replace(/^\/+|\/+$/g, '').trim();
          if (cleanF) {
            const parts = cleanF.split('/');
            let acc = '';
            for (const p of parts) {
              acc = acc ? `${acc}/${p}` : p;
              allBucketFoldersSet.add(acc);
            }
          }
        }
        for (const rawField of [imp.fileId, imp.name]) {
          if (rawField && typeof rawField === 'string' && rawField.includes('/')) {
            const rel = rawField.startsWith(userPrefix)
              ? rawField.slice(userPrefix.length)
              : rawField;
            const cleanRel = rel.replace(/^\/+|\/+$/g, '');
            const parts = cleanRel.split('/');
            let acc = '';
            for (let i = 0; i < parts.length - 1; i++) {
              acc = acc ? `${acc}/${parts[i]}` : parts[i];
              allBucketFoldersSet.add(acc);
            }
          }
        }
      }

      // Discover folders from MongoDB PinnedCids
      const pinnedRecords = await this.pinnedCidModel
        .find({
          bucketName: { $regex: new RegExp(`^${sanitizedName}$`, 'i') },
          $or: [{ owner: ownerObjId as any }, { owner: ownerId as any }],
        })
        .select('fileId name')
        .lean()
        .exec();

      for (const pin of pinnedRecords) {
        for (const rawField of [pin.fileId, pin.name]) {
          if (rawField && typeof rawField === 'string' && rawField.includes('/')) {
            const rel = rawField.startsWith(userPrefix)
              ? rawField.slice(userPrefix.length)
              : rawField;
            const cleanRel = rel.replace(/^\/+|\/+$/g, '');
            const parts = cleanRel.split('/');
            let acc = '';
            for (let i = 0; i < parts.length - 1; i++) {
              acc = acc ? `${acc}/${parts[i]}` : parts[i];
              allBucketFoldersSet.add(acc);
            }
          }
        }
      }

      // 2d. Discover folders from MongoDB Collections
      const collectionRecords = await this.collectionModel
        .find({
          bucketName: sanitizedName,
          owner: ownerObjId as any,
        })
        .select('assets')
        .lean()
        .exec();

      for (const col of collectionRecords) {
        if (col.assets && Array.isArray(col.assets)) {
          for (const asset of col.assets) {
            for (const key of [asset.imageKey, asset.metadataKey]) {
              if (key && typeof key === 'string' && key.includes('/')) {
                const rel = key.startsWith(userPrefix)
                  ? key.slice(userPrefix.length)
                  : key;
                const cleanRel = rel.replace(/^\/+|\/+$/g, '');
                const parts = cleanRel.split('/');
                let acc = '';
                for (let i = 0; i < parts.length - 1; i++) {
                  acc = acc ? `${acc}/${parts[i]}` : parts[i];
                  allBucketFoldersSet.add(acc);
                }
              }
            }
          }
        }
      }
    } catch (folderErr) {
      console.warn('Could not complete full folder discovery:', folderErr.message);
    }

    // 3. Fetch objects for the current folder/page
    try {
      const command = new ListObjectsV2Command({
        Bucket: s3Bucket,
        Prefix: prefix,
        Delimiter: '/',
        MaxKeys: limit,
        ContinuationToken: continuationToken || undefined,
      });
      const response = await s3Client.send(command);

      // Merge any prefixes from this page's response
      if (response.CommonPrefixes) {
        for (const cp of response.CommonPrefixes) {
          if (cp.Prefix) {
            const relPath = cp.Prefix.startsWith(userPrefix)
              ? cp.Prefix.slice(userPrefix.length).replace(/\/$/, '')
              : cp.Prefix.replace(/\/$/, '');
            if (relPath) {
              allBucketFoldersSet.add(relPath);
            }
          }
        }
      }

      // Build structured lists for current directory level and for the entire bucket
      const foldersList: Array<{ name: string; path: string }> = [];
      const allFoldersList: Array<{ name: string; path: string }> = [];

      for (const folderPath of allBucketFoldersSet) {
        const cleanPath = folderPath.replace(/^\/+|\/+$/g, '').trim();
        if (!cleanPath) continue;
        const parts = cleanPath.split('/');
        const folderName = parts[parts.length - 1];
        allFoldersList.push({ name: folderName, path: cleanPath });

        if (!cleanFolder) {
          // Direct child of root
          if (parts.length === 1) {
            foldersList.push({ name: folderName, path: cleanPath });
          }
        } else {
          // Direct child of current folder
          if (cleanPath.startsWith(`${cleanFolder}/`)) {
            const sub = cleanPath.slice(cleanFolder.length + 1);
            if (!sub.includes('/')) {
              foldersList.push({ name: sub, path: cleanPath });
            }
          }
        }
      }

      foldersList.sort((a, b) => a.name.localeCompare(b.name));
      allFoldersList.sort((a, b) => a.name.localeCompare(b.name));

      // Filter out folder markers (keys ending in '/' or matching prefix exactly)
      const objects = (response.Contents || []).filter((obj) => {
        const k = obj.Key || '';
        return k !== prefix && !k.endsWith('/');
      });

      // Generate breadcrumbs navigation path
      const breadcrumbs: Array<{ name: string; path: string }> = [
        { name: 'Root', path: '' },
      ];
      if (cleanFolder) {
        const segments = cleanFolder.split('/').filter(Boolean);
        let accumulated = '';
        for (const seg of segments) {
          accumulated = accumulated ? `${accumulated}/${seg}` : seg;
          breadcrumbs.push({ name: seg, path: accumulated });
        }
      }

      // Fetch user's collections to map metadata details
      const userCollections = await this.collectionModel
        .find({
          bucketName: sanitizedName,
          owner: (bucket.owner || userId) as any,
        })
        .lean()
        .exec();

      const assetMap = new Map<string, { cid: string; name: string; url: string }>();
      for (const col of userCollections) {
        if (col.assets && Array.isArray(col.assets)) {
          for (const asset of col.assets) {
            if (asset.imageKey) {
              const cleanImg = asset.imageKey.startsWith(userPrefix)
                ? asset.imageKey.slice(userPrefix.length)
                : asset.imageKey;
              assetMap.set(cleanImg, {
                cid: asset.imageCid,
                name: asset.name,
                url: asset.imageUrl,
              });
              assetMap.set(cleanImg.split('/').pop() || cleanImg, {
                cid: asset.imageCid,
                name: asset.name,
                url: asset.imageUrl,
              });
            }
            if (asset.metadataKey) {
              const cleanMeta = asset.metadataKey.startsWith(userPrefix)
                ? asset.metadataKey.slice(userPrefix.length)
                : asset.metadataKey;
              assetMap.set(cleanMeta, {
                cid: asset.metadataCid,
                name: `${asset.name} Metadata`,
                url: asset.metadataUrl,
              });
              assetMap.set(cleanMeta.split('/').pop() || cleanMeta, {
                cid: asset.metadataCid,
                name: `${asset.name} Metadata`,
                url: asset.metadataUrl,
              });
            }
          }
        }
      }

      // Fetch user's pinned and imported records for this bucket
      const userPinnedCids = await this.pinnedCidModel
        .find({
          bucketName: sanitizedName,
          owner: (bucket.owner || userId) as any,
        })
        .lean()
        .exec();

      const userImportedCids = await this.importedCidModel
        .find({
          bucketName: sanitizedName,
          $or: [{ owner: (bucket.owner || userId) as any }, { owner: userId as any }],
        })
        .lean()
        .exec();

      const pinnedMap = new Map<string, { cid: string; name: string; url: string; sizeBytes?: number }>();

      const registerPin = (pin: any) => {
        const val = {
          cid: pin.cid,
          name: pin.name || pin.fileId || '',
          url: pin.url || this.pinningService.getGatewayUrl(pin.cid),
          sizeBytes: pin.sizeBytes,
        };
        if (pin.fileId) {
          pinnedMap.set(pin.fileId, val);
          pinnedMap.set(pin.fileId.split('/').pop() || pin.fileId, val);
        }
        if (pin.s3Key) {
          pinnedMap.set(pin.s3Key, val);
          pinnedMap.set(pin.s3Key.split('/').pop() || pin.s3Key, val);
        }
        if (pin.name) {
          pinnedMap.set(pin.name, val);
        }
        if (pin.cid) {
          pinnedMap.set(pin.cid, val);
        }
      };

      for (const pin of userPinnedCids) {
        registerPin(pin);
      }
      for (const imp of userImportedCids) {
        registerPin(imp);
      }

      // Map files list
      const filesList: any[] = [];
      for (const obj of objects) {
        const key = obj.Key || '';
        if (!key) {
          continue;
        }

        let originalKey = key;
        if (userPrefix && key.startsWith(userPrefix)) {
          originalKey = key.slice(userPrefix.length);
        }

        const filename = originalKey.split('/').pop() || originalKey;
        const collectionMatched = assetMap.get(originalKey) || assetMap.get(filename);
        const pinnedMatched =
          pinnedMap.get(originalKey) ||
          pinnedMap.get(filename) ||
          pinnedMap.get(key);

        let cid = collectionMatched?.cid || pinnedMatched?.cid || null;
        let name =
          collectionMatched?.name ||
          pinnedMatched?.name ||
          (filename.includes('_') ? filename.split('_').slice(1).join('_') : filename);
        let url = collectionMatched?.url || pinnedMatched?.url;

        // If CID is still missing, attempt on-the-fly HeadObject to resolve it from Filebase
        if (!cid) {
          try {
            const headCmd = new HeadObjectCommand({
              Bucket: s3Bucket,
              Key: key,
            });
            const headRes = await s3Client.send(headCmd);
            let resolvedCid =
              headRes.Metadata?.['cid'] ||
              headRes.Metadata?.['ipfs-cid'] ||
              headRes.Metadata?.['ipfs_cid'] ||
              headRes.Metadata?.['ipfscid'] ||
              headRes.Metadata?.['ipfs-hash'] ||
              headRes.Metadata?.['ipfs_hash'] ||
              headRes.Metadata?.['ipfshash'] ||
              headRes.Metadata?.['ipfs_pin_hash'] ||
              headRes.Metadata?.['ipfs-pin-hash'];

            if (!resolvedCid && headRes.Metadata) {
              for (const [k, v] of Object.entries(headRes.Metadata)) {
                if (
                  typeof v === 'string' &&
                  (v.startsWith('Qm') ||
                    v.startsWith('bafy') ||
                    v.startsWith('bafk') ||
                    v.startsWith('bafz') ||
                    k.toLowerCase().includes('cid') ||
                    k.toLowerCase().includes('ipfs'))
                ) {
                  resolvedCid = v;
                  break;
                }
              }
            }

            if (resolvedCid) {
              cid = resolvedCid;
              url = this.pinningService.getGatewayUrl(cid);
              const userObjId = new Types.ObjectId(userId);
              const cleanPinnedName =
                filename.includes('_') ? filename.split('_').slice(1).join('_') : filename;
              await this.pinnedCidModel
                .findOneAndUpdate(
                  {
                    bucketName: sanitizedName,
                    cid: resolvedCid,
                    owner: userObjId as any,
                  },
                  {
                    $set: {
                      owner: userObjId as any,
                      bucketName: sanitizedName,
                      cid: resolvedCid,
                      fileId: originalKey,
                      name: cleanPinnedName,
                      sizeBytes: headRes.ContentLength || obj.Size || 0,
                      url,
                    },
                  },
                  { upsert: true, returnDocument: 'after' },
                )
                .exec();
            }
          } catch (err) {
            // Silently fallback if HeadObject fails
          }
        }

        // Detect mimeType & fileType
        const ext = filename.split('.').pop()?.toLowerCase() || '';
        let fileType = 'Other';
        if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) {
          fileType = 'Image';
        } else if (['mp4', 'webm', 'mov', 'avi', 'mkv'].includes(ext)) {
          fileType = 'Video';
        } else if (['mp3', 'wav', 'ogg', 'flac'].includes(ext)) {
          fileType = 'Audio';
        } else if (['json', 'txt', 'csv', 'md', 'html', 'xml'].includes(ext)) {
          fileType = 'Document';
        } else if (['zip', 'tar', 'gz', '7z', 'rar'].includes(ext)) {
          fileType = 'Archive';
        }

        filesList.push({
          key: originalKey,
          filename,
          name,
          cid: cid || 'Processing...',
          url: url || (cid ? this.pinningService.getGatewayUrl(cid) : ''),
          sizeBytes: obj.Size || pinnedMatched?.sizeBytes || 0,
          lastModified: obj.LastModified || new Date(),
          fileType,
          folder: cleanFolder || '',
        });
      }

      // Step 4: Merge imported items from importedcids for the current cleanFolder
      try {
        const ownerObjId = new Types.ObjectId(ownerId);
        const importedQuery: any = {
          bucketName: sanitizedName,
          $or: [{ owner: ownerObjId as any }, { owner: ownerId as any }],
        };
        if (!cleanFolder) {
          importedQuery.$or = [
            { folder: null },
            { folder: '' },
            { folder: { $exists: false } },
          ];
        } else {
          importedQuery.folder = cleanFolder;
        }

        const importedItems = await this.importedCidModel
          .find(importedQuery)
          .lean()
          .exec();

        const existingKeys = new Set(filesList.map((f) => f.key));
        const existingCids = new Set(filesList.map((f) => f.cid).filter(Boolean));

        for (const item of importedItems) {
          const itemKey = item.fileId || (cleanFolder ? `${cleanFolder}/${item.name}` : item.name) || item.cid;
          if (existingKeys.has(itemKey) || (item.cid && existingCids.has(item.cid))) {
            continue;
          }

          const filename = item.name || item.cid;
          const ext = filename.split('.').pop()?.toLowerCase() || '';
          let fileType = item.fileType || 'Other';
          if (!item.fileType) {
            if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) {
              fileType = 'Image';
            } else if (['mp4', 'webm', 'mov', 'avi', 'mkv'].includes(ext)) {
              fileType = 'Video';
            } else if (['mp3', 'wav', 'ogg', 'flac'].includes(ext)) {
              fileType = 'Audio';
            } else if (['json', 'txt', 'csv', 'md', 'html', 'xml'].includes(ext)) {
              fileType = 'Document';
            } else if (['zip', 'tar', 'gz', '7z', 'rar'].includes(ext)) {
              fileType = 'Archive';
            }
          }

          filesList.push({
            key: itemKey,
            filename,
            name: item.name || item.cid,
            cid: item.cid,
            url: item.url || this.pinningService.getGatewayUrl(item.cid),
            sizeBytes: item.sizeBytes || 0,
            lastModified: (item as any).createdAt || new Date(),
            fileType,
            folder: item.folder || cleanFolder || '',
            isImported: true,
          });

          existingKeys.add(itemKey);
          if (item.cid) existingCids.add(item.cid);
        }
      } catch (impErr) {
        console.warn('Could not merge imported items in listBucketFiles:', impErr.message);
      }

      // Calculate total size of files returned
      const totalSizeBytes = filesList.reduce((acc, curr) => acc + (curr.sizeBytes || 0), 0);

      return {
        bucketName: sanitizedName,
        currentFolder: cleanFolder,
        folders: foldersList,
        allFolders: allFoldersList,
        breadcrumbs,
        files: filesList,
        totalFiles: filesList.length,
        totalSizeBytes,
        isTruncated: response.IsTruncated || false,
        nextContinuationToken: response.NextContinuationToken || null,
      };
    } catch (error) {
      throw new BadRequestException(
        `Failed to list objects in bucket '${bucketName}': ${error.message}`,
      );
    }
  }

  /**
   * Retrieves raw object stream from Filebase S3
   */
  async getObject(userId: string, bucketName: string, key: string) {
    await this.clientService.verifyBucketOwnership(userId, bucketName);
    const { s3Bucket, s3Key } = await this.clientService.getS3Params(bucketName, userId, key);
    const command = new GetObjectCommand({
      Bucket: s3Bucket,
      Key: s3Key,
    });
    return this.clientService.getS3Client().send(command);
  }

  /**
   * Retrieves object ACL from Filebase S3
   */
  async getObjectAcl(userId: string, bucketName: string, key: string) {
    await this.clientService.verifyBucketOwnership(userId, bucketName);
    const { s3Bucket, s3Key } = await this.clientService.getS3Params(bucketName, userId, key);
    const command = new GetObjectAclCommand({
      Bucket: s3Bucket,
      Key: s3Key,
    });
    return this.clientService.getS3Client().send(command);
  }

  /**
   * Lists objects using V1 S3 API
   */
  async listObjectsV1(
    userId: string,
    bucketName: string,
    limit?: number,
    marker?: string,
  ) {
    await this.clientService.verifyBucketOwnership(userId, bucketName);
    const { s3Bucket } = await this.clientService.getS3Params(bucketName, userId);
    const command = new ListObjectsCommand({
      Bucket: s3Bucket,
      MaxKeys: limit,
      Marker: marker,
    });
    return this.clientService.getS3Client().send(command);
  }
}
