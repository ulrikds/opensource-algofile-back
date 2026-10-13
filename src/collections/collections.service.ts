import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as crypto from 'crypto';
import * as algosdk from 'algosdk';
import { Collection, CollectionDocument } from './schemas/collection.schema';
import {
  MintTransaction,
  MintTransactionDocument,
} from './schemas/mint-transaction.schema';
import { FilebaseService } from '../filebase/filebase.service';
import { Bucket, BucketDocument } from '../filebase/schemas/bucket.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { PurchasesService } from '../purchases/purchases.service';
import { mapWithConcurrency } from '../common/utils/concurrency';

function decodeBase58(str: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const ALPHABET_MAP: Record<string, number> = {};
  for (let i = 0; i < ALPHABET.length; i++) ALPHABET_MAP[ALPHABET.charAt(i)] = i;
  let bytes = [0];
  for (let i = 0; i < str.length; i++) {
    const c = str.charAt(i);
    if (!(c in ALPHABET_MAP)) throw new Error(`Invalid base58 character: ${c}`);
    let carry = ALPHABET_MAP[c];
    for (let j = 0; j < bytes.length; j++) {
      const val = bytes[j] * 58 + carry;
      bytes[j] = val & 0xff;
      carry = val >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < str.length && str.charAt(i) === '1'; i++) bytes.push(0);
  return new Uint8Array(bytes.reverse());
}

function decodeBase32(str: string): Uint8Array {
  const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
  const ALPHABET_MAP: Record<string, number> = {};
  for (let i = 0; i < ALPHABET.length; i++) ALPHABET_MAP[ALPHABET.charAt(i)] = i;
  const cleanStr = str.toLowerCase().replace(/=/g, '');
  const len = cleanStr.length;
  const buf = new Uint8Array(Math.floor((len * 5) / 8));
  let value = 0;
  let bits = 0;
  let index = 0;
  for (let i = 0; i < len; i++) {
    const c = cleanStr.charAt(i);
    if (!(c in ALPHABET_MAP)) throw new Error(`Invalid base32 character: ${c}`);
    value = (value << 5) | ALPHABET_MAP[c];
    bits += 5;
    if (bits >= 8) {
      buf[index++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  return buf;
}

function cidToReserveAddress(cid: string): string {
  let decoded: Uint8Array;
  if (cid.startsWith('Qm')) {
    decoded = decodeBase58(cid);
  } else if (cid.startsWith('b')) {
    decoded = decodeBase32(cid.substring(1));
  } else {
    throw new Error(`Unsupported CID format: ${cid}`);
  }
  if (decoded.length < 32) {
    throw new Error(`Decoded CID bytes are too short: ${decoded.length}`);
  }
  const digest = decoded.slice(-32);
  return algosdk.encodeAddress(digest);
}

function formatSendLabel(sendNum: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = sendNum % 100;
  const suffix = s[(v - 20) % 10] || s[v] || s[0];
  return `${sendNum}${suffix} Send`;
}


@Injectable()
export class CollectionsService {
  constructor(
    @InjectModel(Collection.name)
    private collectionModel: Model<CollectionDocument>,
    @InjectModel(MintTransaction.name)
    private mintTransactionModel: Model<MintTransactionDocument>,
    @InjectModel(Bucket.name) private bucketModel: Model<BucketDocument>,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    private readonly filebaseService: FilebaseService,
    private readonly purchasesService: PurchasesService,
  ) { }

  private extractTraitsAndMetadata(
    parsedMeta: any,
    assetName: string,
    assetDescription: string,
    imageCid: string,
    mimeType: string,
  ) {
    const traits: Record<string, any> = {};

    if (
      parsedMeta?.properties?.traits &&
      typeof parsedMeta.properties.traits === 'object'
    ) {
      Object.assign(traits, parsedMeta.properties.traits);
    } else if (
      parsedMeta?.traits &&
      typeof parsedMeta.traits === 'object' &&
      !Array.isArray(parsedMeta.traits)
    ) {
      Object.assign(traits, parsedMeta.traits);
    }

    const assetAttributes = parsedMeta?.attributes || parsedMeta?.traits;
    if (Array.isArray(assetAttributes)) {
      for (const attr of assetAttributes) {
        if (attr && typeof attr === 'object') {
          const traitType =
            attr.trait_type || attr.traitType || attr.name || attr.key;
          const traitValue = attr.value;
          if (traitType && traitValue !== undefined) {
            traits[traitType] = traitValue;
          }
        }
      }
    }

    const existingProperties =
      typeof parsedMeta?.properties === 'object' && parsedMeta.properties
        ? parsedMeta.properties
        : {};

    const metadataObject: any = {
      ...(typeof parsedMeta === 'object' && parsedMeta ? parsedMeta : {}),
      name: assetName,
      description: assetDescription,
      image: `ipfs://${imageCid}`,
      image_mimetype: mimeType || parsedMeta?.image_mimetype || 'image/png',
      properties: {
        ...existingProperties,
        traits:
          Object.keys(traits).length > 0
            ? traits
            : existingProperties.traits || {},
      },
    };
    delete metadataObject.attributes;
    delete metadataObject.traits;

    return { traits, metadataObject };
  }

  async listCollections(userId: string): Promise<any[]> {
    const collections = await this.collectionModel
      .find({ owner: userId as any })
      .populate('owner', 'email displayName')
      .sort({ createdAt: -1 })
      .lean()
      .exec();

    return collections.map((col: any) => {
      const allAssets = col.assets || [];
      const totalAssets = allAssets.length;
      const previewAssets = allAssets.slice(0, 3);

      const sendMap = new Map<number, { sendNumber: number; sendLabel: string; count: number }>();
      allAssets.forEach((asset: any) => {
        const sNum = asset.sendNumber || 1;
        const sLabel = asset.sendLabel || formatSendLabel(sNum);
        if (!sendMap.has(sNum)) {
          sendMap.set(sNum, { sendNumber: sNum, sendLabel: sLabel, count: 0 });
        }
        sendMap.get(sNum)!.count++;
      });
      const sendsSummary = Array.from(sendMap.values()).sort((a, b) => a.sendNumber - b.sendNumber);

      return {
        ...col,
        totalAssets,
        sendsSummary,
        assets: previewAssets,
        isPartial: totalAssets > 3,
      };
    });
  }

  async findCollectionById(id: string, userId: string): Promise<any> {
    const collection = await this.collectionModel
      .findOne({ _id: id, owner: userId as any })
      .lean()
      .exec();
    if (!collection) {
      throw new BadRequestException('Collection not found or unauthorized');
    }
    const allAssets = (collection as any).assets || [];
    const sendMap = new Map<number, { sendNumber: number; sendLabel: string; count: number }>();
    allAssets.forEach((asset: any) => {
      const sNum = asset.sendNumber || 1;
      const sLabel = asset.sendLabel || formatSendLabel(sNum);
      if (!sendMap.has(sNum)) {
        sendMap.set(sNum, { sendNumber: sNum, sendLabel: sLabel, count: 0 });
      }
      sendMap.get(sNum)!.count++;
    });
    const sendsSummary = Array.from(sendMap.values()).sort((a, b) => a.sendNumber - b.sendNumber);

    return {
      ...collection,
      totalAssets: allAssets.length,
      sendsSummary,
      isPartial: false,
    };
  }

  async createCollection(
    userId: string,
    userEmail: string,
    bucketName: string,
    name: string,
    description: string,
    files: any[],
    metadataJsonString?: string,
    metadataStandard?: string,
    preUploadedAssets?: any[],
    uploadInterrupted?: boolean,
    isSingleAsset?: boolean,
    collectionId?: string,
    sendNumber?: number,
    sendLabel?: string,
  ): Promise<Collection> {
    if (
      (!files || files.length === 0) &&
      (!preUploadedAssets || preUploadedAssets.length === 0)
    ) {
      throw new BadRequestException(
        'At least one file must be uploaded or pre-uploaded assets provided',
      );
    }

    const user = await this.userModel.findById(userId).exec();
    if (!user) {
      throw new BadRequestException('User profile not found.');
    }

    let targetCollection;
    if (collectionId) {
      targetCollection = await this.collectionModel
        .findOne({ _id: collectionId, owner: userId as any })
        .exec();
      if (!targetCollection) {
        throw new BadRequestException('Collection not found or unauthorized');
      }
    }

    let targetSendNum: number = sendNumber !== undefined ? sendNumber : 1;
    if (collectionId && !sendNumber) {
      const maxSend = targetCollection.assets.reduce(
        (max, a) => Math.max(max, (a as any).sendNumber || 1),
        0,
      );
      targetSendNum = maxSend + 1;
    }

    let targetSendLabel = sendLabel;
    if (collectionId && !targetSendLabel) {
      targetSendLabel = formatSendLabel(targetSendNum);
    } else if (!targetSendLabel) {
      targetSendLabel = '1st Send';
    }

    // Calculate incoming payload size (in bytes)
    const incomingSizeBytes =
      preUploadedAssets && preUploadedAssets.length > 0
        ? 0
        : files.reduce((acc, f) => acc + (f.size || 0), 0);

    // 1. Fetch bucket details to check storage limit and ownership
    const bucket = await this.bucketModel
      .findOne({ name: bucketName.toLowerCase() })
      .exec();
    if (!bucket) {
      throw new BadRequestException(
        `Target S3 bucket '${bucketName}' is not registered on the platform.`,
      );
    }

    const isOfficialBucket = [
      'algofilerouteapi',
      'algofilerouteapi6m',
      'algofilerouteapi1y',
      'algofilerouteapi2y',
    ].includes(bucketName.toLowerCase());

    const isFreeBucket = !bucket.owner && !isOfficialBucket;

    if (isFreeBucket) {
      const globalPoolLimitBytes = 10 * 1024 * 1024 * 1024;
      const globalPoolUsedBytes =
        await this.filebaseService.recalculateFreeBucketPoolStorage();
      if (globalPoolUsedBytes + incomingSizeBytes > globalPoolLimitBytes) {
        throw new BadRequestException(
          `Upload blocked: The shared global free storage pool of 10 GB is full. No more uploads allowed to the free bucket until storage is freed.`,
        );
      }

      const userLimitBytes = 250 * 1024 * 1024; // 250 MB limit
      if (user.usedStorageBytes + incomingSizeBytes > userLimitBytes) {
        const remainingUserBytes = userLimitBytes - user.usedStorageBytes;
        const remainingUserMb = Math.max(
          0,
          remainingUserBytes / (1024 * 1024),
        ).toFixed(2);
        throw new BadRequestException(
          `Upload blocked: You have exceeded your free sandbox limit of 250 MB. Remaining storage: ${remainingUserMb} MB. Please purchase a dedicated bucket in the dashboard.`,
        );
      }
    } else if (!isOfficialBucket) {
      // Verify custom bucket ownership
      if (bucket.owner?.toString() !== userId) {
        throw new BadRequestException(
          `Access denied: You do not own the bucket '${bucketName}'.`,
        );
      }

      // Verify custom bucket expiration
      if (bucket.expiresAt && new Date() > bucket.expiresAt) {
        throw new BadRequestException(
          `Upload blocked: The bucket '${bucketName}' has expired on ${bucket.expiresAt.toLocaleString()}.`,
        );
      }

      // Verify custom bucket storage limit
      const limitBytes = bucket.maxSizeGb * 1024 * 1024 * 1024;
      if (bucket.usedSizeBytes + incomingSizeBytes > limitBytes) {
        const remainingBytes = limitBytes - bucket.usedSizeBytes;
        const remainingMb = Math.max(0, remainingBytes / (1024 * 1024)).toFixed(
          2,
        );
        throw new BadRequestException(
          `Upload blocked: This bucket has exceeded its storage limit of ${bucket.maxSizeGb} GB. Remaining storage: ${remainingMb} MB.`,
        );
      }
    }

    let customMetadataList: any[] = [];
    if (
      metadataJsonString &&
      (!preUploadedAssets || preUploadedAssets.length === 0)
    ) {
      try {
        customMetadataList = JSON.parse(metadataJsonString);
      } catch (err) {
        throw new BadRequestException('Invalid metadata JSON string format');
      }
    }

    let assets: any[] = [];
    let totalUploadedBytes = 0;

    if (preUploadedAssets && preUploadedAssets.length > 0) {
      assets = preUploadedAssets;
    } else {
      // Parallel upload with concurrency limit of 4
      const concurrencyLimit = 4;
      let nextIndex = 0;

      const workers = Array.from(
        { length: Math.min(concurrencyLimit, files.length) },
        async () => {
          while (nextIndex < files.length) {
            const i = nextIndex++;
            const file = files[i];
            const customMeta = customMetadataList[i] || {};

            // 2. Upload Image to Filebase (or reuse CID if identical content already exists)
            const imageHash = crypto
              .createHash('sha256')
              .update(file.buffer)
              .digest('hex');

            const timestamp = Date.now();
            const sanitizedFilename = file.originalname.replace(
              /[^a-zA-Z0-9.]/g,
              '_',
            );
            const sanitizedEmail = userEmail.toLowerCase().trim();

            let imageKey: string;
            if (isSingleAsset) {
              imageKey = `${sanitizedEmail}/${timestamp}_${sanitizedFilename}`;
            } else {
              const sanitizedFolderName = name
                .toLowerCase()
                .replace(/[^a-z0-9]/g, '_');
              imageKey = `${sanitizedEmail}/${sanitizedFolderName}/${timestamp}_${sanitizedFilename}`;
            }

            const imageUploadResult = await this.filebaseService.uploadFile(
              userId,
              bucketName,
              imageKey,
              file.buffer,
              file.mimetype,
            );

            totalUploadedBytes += imageUploadResult.sizeBytes;

            // 3. Generate NFT Metadata
            const assetName = customMeta.name || file.originalname.replace(/\.[^/.]+$/, '');
            const assetDescription =
              customMeta.description || `Asset of ${name}`;

            const { traits, metadataObject } = this.extractTraitsAndMetadata(
              customMeta,
              assetName,
              assetDescription,
              imageUploadResult.cid,
              file.mimetype,
            );

            const metadataBuffer = Buffer.from(
              JSON.stringify(metadataObject, null, 2),
            );
            const metadataKey = `${imageKey}.json`;

            // 4. Upload NFT Metadata JSON to Filebase (or reuse CID if identical content already exists)
            const metadataHash = crypto
              .createHash('sha256')
              .update(metadataBuffer)
              .digest('hex');

            const metadataUploadResult = await this.filebaseService.uploadFile(
              userId,
              bucketName,
              metadataKey,
              metadataBuffer,
              'application/json',
            );

            totalUploadedBytes += metadataUploadResult.sizeBytes;

            assets.push({
              name: assetName,
              imageKey,
              imageCid: imageUploadResult.cid,
              imageUrl: imageUploadResult.url,
              metadataKey,
              metadataCid: metadataUploadResult.cid,
              metadataUrl: metadataUploadResult.url,
              mimeType: file.mimetype,
              index: i,
              imageHash,
              metadataHash,
              imageSize: imageUploadResult.sizeBytes,
              metadataSize: metadataUploadResult.sizeBytes,
              sendNumber: targetSendNum,
              sendLabel: targetSendLabel,
              uploadedAt: new Date(),
            });
          }
        },
      );

      await Promise.all(workers);

      // Sort assets to match original file order
      assets.sort((a, b) => a.index - b.index);
      // 5. Update bucket and user size usage in DB atomically to prevent version/locking errors
      await this.bucketModel
        .updateOne(
          { _id: bucket._id },
          { $inc: { usedSizeBytes: totalUploadedBytes } },
        )
        .exec();

      await this.userModel
        .updateOne(
          { _id: userId },
          { $inc: { usedStorageBytes: totalUploadedBytes } },
        )
        .exec();
    }

    // 6. Save/Update Collection to DB
    if (collectionId) {
      const res = await this.collectionModel
        .findOneAndUpdate(
          { _id: collectionId, owner: userId as any },
          { $push: { assets: { $each: assets } } },
          { new: true },
        )
        .exec();
      if (!res) {
        throw new BadRequestException('Collection not found or unauthorized');
      }
      return res;
    }

    const newCollection = new this.collectionModel({
      name,
      description,
      bucketName,
      owner: userId as any,
      assets,
      metadataStandard: metadataStandard || 'arc19',
      uploadInterrupted: uploadInterrupted || false,
    });

    return newCollection.save();
  }

  async updateMintedAssets(
    collectionId: string,
    userId: string,
    minted: Array<{ imageCid: string; assetId: number; txId?: string }>,
    txIds?: string[],
    sender?: string,
    network?: string,
  ): Promise<Collection> {
    const collection = await this.collectionModel
      .findOne({ _id: collectionId, owner: userId as any })
      .exec();
    if (!collection) {
      throw new BadRequestException('Collection not found or unauthorized');
    }

    let userNetwork = network;
    if (!userNetwork) {
      const user = await this.userModel.findById(userId).exec();
      userNetwork = user?.mintNetwork || 'mainnet';
    }

    const idxBaseUrl =
      userNetwork === 'mainnet'
        ? 'https://mainnet-idx.4160.nodely.dev'
        : 'https://testnet-idx.4160.nodely.dev';

    for (let i = 0; i < minted.length; i++) {
      const item = minted[i] as any;
      const targetSendNum = item.sendNumber ? Number(item.sendNumber) : null;

      const asset =
        collection.assets.find(
          (a: any) =>
            !a.assetId &&
            (targetSendNum ? (a.sendNumber || 1) === targetSendNum : true) &&
            ((item.metadataKey && a.metadataKey === item.metadataKey) ||
              (item.imageKey && a.imageKey === item.imageKey) ||
              (item.imageCid && a.imageCid === item.imageCid) ||
              (item.metadataCid && a.metadataCid === item.metadataCid)),
        ) ||
        collection.assets.find(
          (a: any) =>
            !a.assetId &&
            (targetSendNum ? (a.sendNumber || 1) === targetSendNum : true),
        ) ||
        collection.assets.find(
          (a: any) =>
            !a.assetId &&
            ((item.metadataKey && a.metadataKey === item.metadataKey) ||
              (item.imageKey && a.imageKey === item.imageKey) ||
              (item.imageCid && a.imageCid === item.imageCid) ||
              (item.metadataCid && a.metadataCid === item.metadataCid)),
        ) ||
        collection.assets.find(
          (a: any) => item.imageCid && a.imageCid === item.imageCid,
        );

      if (asset) {
        asset.assetId = item.assetId;

        // Update assetId in CID records
        this.filebaseService.saveCidRecord({
          cid: asset.imageCid,
          bucketName: collection.bucketName,
          fileId: asset.imageKey,
          assetId: item.assetId,
          owner: userId,
        });
        if (asset.metadataCid) {
          this.filebaseService.saveCidRecord({
            cid: asset.metadataCid,
            bucketName: collection.bucketName,
            fileId: asset.metadataKey,
            assetId: item.assetId,
            owner: userId,
          });
        }

        // Extract transaction ID
        const txId = item.txId || (txIds && txIds[i]);
        if (txId) {
          // Attempt to query round number from Indexer
          let round = 0;
          try {
            const indexerRes = await fetch(
              `${idxBaseUrl}/v2/transactions/${txId}`,
            );
            if (indexerRes.ok) {
              const txData: any = await indexerRes.json();
              round =
                txData.transaction?.['confirmed-round'] ||
                txData.transaction?.confirmedRound ||
                0;
            }
          } catch (e) {
            console.warn(
              `Failed to fetch confirmed round from Indexer for tx ${txId}:`,
              e,
            );
          }

          const assetURL =
            collection.metadataStandard === 'arc19'
              ? `template-ipfs://{ipfscid:1:raw:reserve:sha2-256}`
              : `ipfs://${asset.metadataCid}#arc3`;

          const existingTx = await this.mintTransactionModel
            .findOne({ txId })
            .exec();
          if (!existingTx) {
            const newTx = new this.mintTransactionModel({
              txId,
              assetId: item.assetId,
              name: asset.name,
              unitName: 'NFT',
              url: assetURL,
              sender: sender || 'unknown',
              metadataCid: asset.metadataCid,
              network: userNetwork,
              collectionId: collection._id,
              round: round || undefined,
            });
            await newTx.save();
          }
        }
      }
    }

    return collection.save();
  }

  async getMintTransactions(query: {
    sender?: string;
    txId?: string;
    network?: string;
    limit?: number;
    skip?: number;
    withTotal?: boolean;
  }): Promise<any> {
    const filter: any = {};
    if (query.sender) {
      filter.sender = query.sender;
    }
    if (query.txId) {
      filter.txId = query.txId;
    }
    if (query.network) {
      filter.network = query.network;
    }
    const limit = Math.min(query.limit || 50, 5000);
    const skip = Math.max(0, query.skip || 0);

    const totalCountPromise = query.withTotal
      ? this.mintTransactionModel.countDocuments(filter).exec()
      : Promise.resolve(null);

    const txsPromise = this.mintTransactionModel
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('collectionId')
      .exec();

    const [totalCount, txs] = await Promise.all([totalCountPromise, txsPromise]);

    // Query bucket expiration dates
    const bucketNames = txs
      .map((tx) => (tx.collectionId as any)?.bucketName)
      .filter((name) => !!name);

    const buckets = await this.bucketModel
      .find({ name: { $in: bucketNames } })
      .exec();
    const bucketMap = new Map<string, Date | null>();
    for (const b of buckets) {
      bucketMap.set(b.name.toLowerCase(), b.expiresAt || null);
    }

    const items = txs.map((tx) => {
      const collection = tx.collectionId as any;
      const bName = collection?.bucketName || 'unknown';
      const expiresAt = bucketMap.get(bName.toLowerCase()) || null;

      // Find the specific asset from the collection to get its imageCid and imageUrl
      const asset = collection?.assets?.find(
        (a) => a.metadataCid === tx.metadataCid,
      );
      const imageCid = asset?.imageCid || '';
      const imageUrl = asset?.imageUrl || '';

      return {
        _id: tx._id,
        txId: tx.txId,
        assetId: tx.assetId,
        name: tx.name,
        unitName: tx.unitName,
        url: tx.url,
        sender: tx.sender,
        metadataCid: tx.metadataCid,
        network: tx.network,
        round: tx.round,
        createdAt: tx.createdAt,
        bucketName: bName,
        bucketExpiresAt: expiresAt,
        imageCid,
        imageUrl,
      };
    });

    if (query.withTotal) {
      return { items, total: totalCount || 0 };
    }
    return items;
  }

  async deleteCollection(
    id: string,
    userId: string,
  ): Promise<{ message: string }> {
    const collection = await this.collectionModel
      .findOne({ _id: id, owner: userId as any })
      .exec();
    if (!collection) {
      throw new BadRequestException('Collection not found or unauthorized');
    }

    const bucketName = collection.bucketName;
    const bucket = await this.bucketModel
      .findOne({ name: bucketName.toLowerCase() })
      .exec();

    const isFreeBucket = !bucket || !bucket.owner;
    let reclaimedBytes = 0;

    for (const asset of collection.assets) {
      if (asset.imageKey) {
        // Check if other collections reference this image CID
        const isImageShared =
          (await this.collectionModel
            .countDocuments({
              _id: { $ne: collection._id },
              'assets.imageCid': asset.imageCid,
            })
            .exec()) > 0;

        let imageSize = 0;
        if (isImageShared) {
          // If shared, do NOT delete from S3/Filebase, just retrieve size to reclaim logical storage
          imageSize =
            (asset as any).imageSize ||
            (await this.filebaseService.getFileSize(
              userId,
              bucketName,
              asset.imageKey,
            ));
        } else {
          // If not shared, delete physically from Filebase S3
          imageSize = await this.filebaseService.deleteFile(
            userId,
            bucketName,
            asset.imageKey,
          );
        }
        reclaimedBytes += imageSize;
      }
      if (asset.metadataKey) {
        // Check if other collections reference this metadata CID
        const isMetadataShared =
          (await this.collectionModel
            .countDocuments({
              _id: { $ne: collection._id },
              'assets.metadataCid': asset.metadataCid,
            })
            .exec()) > 0;

        let metadataSize = 0;
        if (isMetadataShared) {
          // If shared, do NOT delete from S3/Filebase, just retrieve size to reclaim logical storage
          metadataSize =
            (asset as any).metadataSize ||
            (await this.filebaseService.getFileSize(
              userId,
              bucketName,
              asset.metadataKey,
            ));
        } else {
          // If not shared, delete physically from Filebase S3
          metadataSize = await this.filebaseService.deleteFile(
            userId,
            bucketName,
            asset.metadataKey,
          );
        }
        reclaimedBytes += metadataSize;
      }
    }

    if (bucket) {
      bucket.usedSizeBytes = Math.max(0, bucket.usedSizeBytes - reclaimedBytes);
      await bucket.save();
    }

    if (isFreeBucket) {
      const user = await this.userModel.findById(userId).exec();
      if (user) {
        user.usedStorageBytes = Math.max(
          0,
          user.usedStorageBytes - reclaimedBytes,
        );
        await user.save();
      }
    }

    await this.collectionModel.deleteOne({ _id: id }).exec();

    return {
      message: 'Collection and associated IPFS files successfully deleted.',
    };
  }

  async createCollectionWithBundle(
    userId: string,
    userEmail: string,
    paymentTxId: string,
    planType: string,
    durationMonths: number,
    name: string,
    description: string,
    files: any[],
    metadataJsonString?: string,
    metadataStandard?: string,
    preUploadedAssets?: any[],
  ): Promise<Collection> {
    // 1. Calculate the weight of the collection files in bytes
    let totalBytes = 0;
    if (preUploadedAssets && preUploadedAssets.length > 0) {
      totalBytes = preUploadedAssets.reduce(
        (acc, a) => acc + (a.sizeBytes || 0),
        0,
      );
    } else {
      totalBytes = files.reduce((acc, f) => acc + (f.size || 0), 0);
    }
    const minBytes = 10 * 1024 * 1024; // 10 MB minimum floor
    const effectiveBytes = Math.max(totalBytes, minBytes);
    const totalGb = effectiveBytes / (1024 * 1024 * 1024);

    // Custom storage rate is $0.40 per GB per month with 25MB minimum floor
    const duration = durationMonths || 6;
    const customPriceUsd = totalGb * 0.4 * duration;

    // Enforce exactly the file size weight so that no leftover space remains
    const customGb = totalGb;

    // 2. Verify and execute the bucket purchase using PurchasesService with custom parameters
    await this.purchasesService.verifyPurchase(
      userId,
      paymentTxId,
      'custom',
      duration,
      customPriceUsd,
      customGb,
    );

    // 2. Query the user's latest created bucket to get the bucketName
    const bucket = await this.bucketModel
      .findOne({ owner: userId as any })
      .sort({ createdAt: -1 })
      .exec();
    if (!bucket) {
      throw new BadRequestException(
        'Failed to find the newly provisioned storage bucket.',
      );
    }

    // 3. Invoke standard createCollection
    return this.createCollection(
      userId,
      userEmail,
      bucket.name,
      name,
      description,
      files,
      metadataJsonString,
      metadataStandard,
      preUploadedAssets,
    );
  }

  async uploadSingleAsset(
    userId: string,
    userEmail: string,
    bucketName: string,
    collectionName: string,
    file: any,
    customMeta: any,
    metadataStandardInput?: string,
  ): Promise<any> {
    const bucket = await this.bucketModel
      .findOne({ name: bucketName.toLowerCase() })
      .exec();
    if (!bucket) {
      throw new BadRequestException(
        `Target S3 bucket '${bucketName}' is not registered on the platform.`,
      );
    }

    const isFreeBucket = !bucket.owner;

    if (!isFreeBucket) {
      // Verify custom bucket ownership
      if (bucket.owner?.toString() !== userId) {
        throw new BadRequestException(
          `Access denied: You do not own the bucket '${bucketName}'.`,
        );
      }
      // Verify custom bucket expiration
      if (bucket.expiresAt && new Date() > bucket.expiresAt) {
        throw new BadRequestException(
          `Upload blocked: The bucket '${bucketName}' has expired on ${bucket.expiresAt.toLocaleString()}.`,
        );
      }
    }

    // 2. Upload Image to Filebase (or reuse CID if identical content already exists)
    const imageHash = crypto
      .createHash('sha256')
      .update(file.buffer)
      .digest('hex');

    const timestamp = Date.now();
    const sanitizedFilename = file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');
    const sanitizedEmail = userEmail.toLowerCase().trim();
    const sanitizedFolderName = collectionName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '_');
    const imageKey = `${sanitizedEmail}/${sanitizedFolderName}/${timestamp}_${sanitizedFilename}`;

    const imageUploadResult = await this.filebaseService.uploadFile(
      userId,
      bucketName,
      imageKey,
      file.buffer,
      file.mimetype,
    );

    // 3. Generate NFT Metadata
    const assetName = customMeta.name || `${collectionName} Asset`;
    const assetDescription =
      customMeta.description || `Asset of ${collectionName}`;
    const assetAttributes = customMeta.attributes || [];

    // Query collection metadataStandard if not provided by frontend
    let metadataStandard = metadataStandardInput;
    if (!metadataStandard) {
      const escapedCollectionName = collectionName
        .trim()
        .replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
      const collection = await this.collectionModel
        .findOne({
          name: { $regex: new RegExp(`^${escapedCollectionName}$`, 'i') },
          owner: userId as any,
        })
        .exec();
      metadataStandard = collection?.metadataStandard || 'arc19';
    }

    // Format traits as key-value pairs inside properties.traits
    const traits: Record<string, string> = {};
    if (Array.isArray(assetAttributes)) {
      for (const attr of assetAttributes) {
        if (attr && typeof attr === 'object') {
          const traitType = attr.trait_type || attr.traitType;
          const traitValue = attr.value;
          if (traitType && traitValue !== undefined) {
            traits[traitType] = traitValue;
          }
        }
      }
    }

    const metadataObject: any = {
      name: assetName,
      description: assetDescription,
      image: `ipfs://${imageUploadResult.cid}`,
      image_mimetype: file.mimetype || 'image/png',
      properties: {
        traits: traits,
      },
    };

    const metadataBuffer = Buffer.from(JSON.stringify(metadataObject, null, 2));
    const metadataKey = `${imageKey}.json`;

    // 4. Upload NFT Metadata JSON to Filebase (or reuse CID if identical content already exists)
    const metadataHash = crypto
      .createHash('sha256')
      .update(metadataBuffer)
      .digest('hex');

    const metadataUploadResult = await this.filebaseService.uploadFile(
      userId,
      bucketName,
      metadataKey,
      metadataBuffer,
      'application/json',
    );

    const totalUploadedBytes =
      imageUploadResult.sizeBytes + metadataUploadResult.sizeBytes;

    // 5. Update bucket and user size usage in DB atomically to prevent version/locking errors
    await this.bucketModel
      .updateOne(
        { _id: bucket._id },
        { $inc: { usedSizeBytes: totalUploadedBytes } },
      )
      .exec();

    await this.userModel
      .updateOne(
        { _id: userId },
        { $inc: { usedStorageBytes: totalUploadedBytes } },
      )
      .exec();

    await this.filebaseService.saveCidRecord({
      cid: imageUploadResult.cid,
      bucketName,
      name: file.originalname,
      fileId: imageKey,
      sizeBytes: imageUploadResult.sizeBytes,
      mimeType: file.mimetype,
      owner: userId,
    });

    await this.filebaseService.saveCidRecord({
      cid: metadataUploadResult.cid,
      bucketName,
      name: `${assetName} Metadata`,
      fileId: metadataKey,
      sizeBytes: metadataUploadResult.sizeBytes,
      mimeType: 'application/json',
      metadata: metadataObject,
      owner: userId,
    });

    return {
      name: assetName,
      imageKey,
      imageCid: imageUploadResult.cid,
      imageUrl: imageUploadResult.url,
      metadataKey,
      metadataCid: metadataUploadResult.cid,
      metadataUrl: metadataUploadResult.url,
      mimeType: file.mimetype,
      imageSize: imageUploadResult.sizeBytes,
      metadataSize: metadataUploadResult.sizeBytes,
      imageHash,
      metadataHash,
    };
  }

  async provisionBundleBucket(
    userId: string,
    paymentTxId: string,
    totalGb: number,
    durationMonths: number,
    mintType?: string,
  ): Promise<{ bucketName: string }> {
    const duration = durationMonths || 6;
    const minGb = (10 * 1024 * 1024) / (1024 * 1024 * 1024);
    const effectiveGb = Math.max(totalGb, minGb);
    const customPriceUsd = effectiveGb * 0.4 * duration;
    const customGb = effectiveGb;

    // Verify purchase
    await this.purchasesService.verifyPurchase(
      userId,
      paymentTxId,
      'custom',
      duration,
      customPriceUsd,
      customGb,
      undefined,
      mintType,
    );

    // Return the official public bucket for custom memory NFT storage
    return { bucketName: 'algofilerouteapi' };
  }

  async provisionBundleBucketX402(
    userId: string,
    x402Payload: any,
    totalGb: number,
    durationMonths: number,
    mintType?: string,
    projectName?: string,
    projectDescription?: string,
    projectIcon?: string,
  ): Promise<{ bucketName: string }> {
    const duration = durationMonths || 6;
    const minGb = (10 * 1024 * 1024) / (1024 * 1024 * 1024);
    const effectiveGb = Math.max(totalGb, minGb);
    const customPriceUsd = effectiveGb * 0.4 * duration;
    const customGb = effectiveGb;

    await this.purchasesService.verifyX402Purchase(
      userId,
      x402Payload,
      'custom',
      duration,
      'USDC',
      customPriceUsd,
      customGb,
      undefined,
      mintType,
      projectName,
      projectDescription,
      projectIcon,
    );

    // Return the official public bucket for custom memory NFT storage
    return { bucketName: 'algofilerouteapi' };
  }

  async initializeCollection(
    userId: string,
    bucketName: string,
    name: string,
    description: string,
    metadataStandard?: string,
  ): Promise<Collection> {
    const bucket = await this.bucketModel
      .findOne({ name: bucketName.toLowerCase() })
      .exec();
    if (!bucket) {
      throw new BadRequestException(
        `Target S3 bucket '${bucketName}' is not registered on the platform.`,
      );
    }

    if (bucket.owner && bucket.owner.toString() !== userId) {
      throw new BadRequestException(
        `Access denied: You do not own the bucket '${bucketName}'.`,
      );
    }

    const newCollection = new this.collectionModel({
      name,
      description,
      bucketName,
      owner: userId as any,
      assets: [],
      metadataStandard: metadataStandard || 'arc19',
      uploadInterrupted: true,
    });

    return newCollection.save();
  }

  async addAssetToCollection(
    collectionId: string,
    userId: string,
    asset: any,
  ): Promise<{ success: boolean }> {
    const res = await this.collectionModel
      .updateOne(
        { _id: collectionId, owner: userId as any },
        { $push: { assets: asset } },
      )
      .exec();

    if (res.matchedCount === 0) {
      throw new BadRequestException('Collection not found or unauthorized');
    }
    return { success: true };
  }

  async finalizeCollection(
    collectionId: string,
    userId: string,
  ): Promise<Collection> {
    const collection = await this.collectionModel
      .findOne({ _id: collectionId, owner: userId as any })
      .exec();
    if (!collection) {
      throw new BadRequestException('Collection not found or unauthorized');
    }
    collection.uploadInterrupted = false;
    return collection.save();
  }

  async generatePresignedUrl(
    userId: string,
    userEmail: string,
    bucketName: string,
    collectionName: string,
    fileName: string,
    contentType: string,
  ): Promise<{ uploadUrl: string; imageKey: string }> {
    const timestamp = Date.now();
    const sanitizedFilename = fileName.replace(/[^a-zA-Z0-9.]/g, '_');
    const sanitizedEmail = userEmail.toLowerCase().trim();
    const sanitizedFolderName = collectionName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '_');
    const imageKey = `${sanitizedEmail}/${sanitizedFolderName}/${timestamp}_${sanitizedFilename}`;

    const uploadUrl = await this.filebaseService.getPresignedUploadUrl(
      userId,
      bucketName,
      imageKey,
      contentType,
    );

    return { uploadUrl, imageKey };
  }

  async registerUploadedAsset(
    userId: string,
    userEmail: string,
    bucketName: string,
    collectionName: string,
    imageKey: string,
    imageHash: string,
    fileName: string,
    mimeType: string,
    customMeta: any,
    metadataStandardInput?: string,
    imageCidInput?: string,
  ): Promise<any> {
    const bucket = await this.bucketModel
      .findOne({ name: bucketName.toLowerCase() })
      .exec();
    if (!bucket) {
      throw new BadRequestException(
        `Target S3 bucket '${bucketName}' is not registered on the platform.`,
      );
    }

    const isFreeBucket = !bucket.owner;
    if (!isFreeBucket) {
      if (bucket.owner?.toString() !== userId) {
        throw new BadRequestException(
          `Access denied: You do not own the bucket '${bucketName}'.`,
        );
      }
      if (bucket.expiresAt && new Date() > bucket.expiresAt) {
        throw new BadRequestException(
          `Upload blocked: The bucket '${bucketName}' has expired on ${bucket.expiresAt.toLocaleString()}.`,
        );
      }
    }

    // 1. Fetch file info (CID and size) from S3/Filebase or use provided CID
    let imageUploadResult: { key: string; cid: string; url: string; sizeBytes: number };
    if (imageCidInput) {
      imageUploadResult = {
        key: imageKey,
        cid: imageCidInput,
        url: this.filebaseService.getGatewayUrl(imageCidInput),
        // The client knows the CID but its size must still come from S3, or the image is never charged.
        sizeBytes: await this.filebaseService.getFileSize(userId, bucketName, imageKey),
      };
    } else {
      const fileMetadata = await this.filebaseService.getFileMetadata(
        userId,
        bucketName,
        imageKey,
      );

      imageUploadResult = {
        key: imageKey,
        cid: fileMetadata.cid,
        url: this.filebaseService.getGatewayUrl(fileMetadata.cid),
        sizeBytes: fileMetadata.sizeBytes,
      };
    }

    // 2. Generate NFT Metadata
    const assetName = customMeta?.name || `${collectionName} Asset`;
    const assetDescription =
      customMeta?.description || `Asset of ${collectionName}`;
    const assetAttributes = customMeta?.attributes || [];

    let metadataStandard = metadataStandardInput;
    if (!metadataStandard) {
      const collection = await this.collectionModel
        .findOne({
          name: collectionName.trim(),
          owner: userId as any,
        })
        .select('metadataStandard')
        .lean()
        .exec();
      metadataStandard = collection?.metadataStandard || 'arc19';
    }

    const traits: Record<string, string> = {};
    if (Array.isArray(assetAttributes)) {
      for (const attr of assetAttributes) {
        if (attr && typeof attr === 'object') {
          const traitType = attr.trait_type || attr.traitType;
          const traitValue = attr.value;
          if (traitType && traitValue !== undefined) {
            traits[traitType] = traitValue;
          }
        }
      }
    }

    const metadataObject: any = {
      name: assetName,
      description: assetDescription,
      image: `ipfs://${imageUploadResult.cid}`,
      image_mimetype: mimeType || 'image/png',
      properties: {
        traits: traits,
      },
    };

    const metadataBuffer = Buffer.from(JSON.stringify(metadataObject, null, 2));
    const metadataKey = `${imageKey}.json`;

    // 3. Upload NFT Metadata JSON to Filebase (checking for duplicates or normal upload)
    const metadataHash = crypto
      .createHash('sha256')
      .update(metadataBuffer)
      .digest('hex');

    const metadataUploadResult = await this.filebaseService.uploadFile(
      userId,
      bucketName,
      metadataKey,
      metadataBuffer,
      'application/json',
    );

    const totalUploadedBytes =
      imageUploadResult.sizeBytes + metadataUploadResult.sizeBytes;

    // 4. Update bucket and user size usage in DB
    await this.bucketModel
      .updateOne(
        { _id: bucket._id },
        { $inc: { usedSizeBytes: totalUploadedBytes } },
      )
      .exec();

    await this.userModel
      .updateOne(
        { _id: userId },
        { $inc: { usedStorageBytes: totalUploadedBytes } },
      )
      .exec();

    await this.filebaseService.saveCidRecord({
      cid: imageUploadResult.cid,
      bucketName,
      name: fileName,
      fileId: imageKey,
      sizeBytes: imageUploadResult.sizeBytes,
      mimeType: mimeType || 'image/png',
      owner: userId,
    });

    await this.filebaseService.saveCidRecord({
      cid: metadataUploadResult.cid,
      bucketName,
      name: `${assetName} Metadata`,
      fileId: metadataKey,
      sizeBytes: metadataUploadResult.sizeBytes,
      mimeType: 'application/json',
      metadata: metadataObject,
      owner: userId,
    });

    return {
      name: assetName,
      imageKey,
      imageCid: imageUploadResult.cid,
      imageUrl: imageUploadResult.url,
      metadataKey,
      metadataCid: metadataUploadResult.cid,
      metadataUrl: metadataUploadResult.url,
      mimeType,
      imageSize: imageUploadResult.sizeBytes,
      metadataSize: metadataUploadResult.sizeBytes,
      imageHash,
      metadataHash,
    };
  }

  async generatePresignedUrlsBulk(
    userId: string,
    userEmail: string,
    bucketName: string,
    collectionName: string,
    items: Array<{ fileName: string; contentType?: string }>,
  ): Promise<Array<{ fileName: string; uploadUrl: string; imageKey: string }>> {
    const timestamp = Date.now();
    const sanitizedEmail = userEmail.toLowerCase().trim();
    const sanitizedFolderName = collectionName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '_');

    const results = await mapWithConcurrency(
      items,
      16,
      async (item, idx) => {
        const sanitizedFilename = item.fileName.replace(/[^a-zA-Z0-9.]/g, '_');
        const imageKey = `${sanitizedEmail}/${sanitizedFolderName}/${timestamp}_${idx}_${sanitizedFilename}`;
        const contentType = item.contentType || 'image/png';
        const uploadUrl = await this.filebaseService.getPresignedUploadUrl(
          userId,
          bucketName,
          imageKey,
          contentType,
        );
        return { fileName: item.fileName, uploadUrl, imageKey };
      },
    );

    return results;
  }

  async registerUploadedAssetsBulk(
    userId: string,
    userEmail: string,
    collectionId: string,
    bucketName: string,
    collectionName: string,
    items: Array<{
      imageKey: string;
      imageHash: string;
      fileName: string;
      mimeType: string;
      metadata: any;
      imageCid?: string;
    }>,
    metadataStandardInput?: string,
    sendNumberInput?: number,
    sendLabelInput?: string,
  ): Promise<any[]> {
    if (items.length > 2000) {
      throw new BadRequestException(
        'Upload blocked: A single send batch cannot exceed 2,000 assets (2,000 images + 2,000 JSON metadata files).',
      );
    }

    const bucket = await this.bucketModel
      .findOne({ name: bucketName.toLowerCase() })
      .exec();
    if (!bucket) {
      throw new BadRequestException(
        `Target S3 bucket '${bucketName}' is not registered on the platform.`,
      );
    }

    const isFreeBucket = !bucket.owner;
    if (!isFreeBucket) {
      if (bucket.owner?.toString() !== userId) {
        throw new BadRequestException(
          `Access denied: You do not own the bucket '${bucketName}'.`,
        );
      }
      if (bucket.expiresAt && new Date() > bucket.expiresAt) {
        throw new BadRequestException(
          `Upload blocked: The bucket '${bucketName}' has expired on ${bucket.expiresAt.toLocaleString()}.`,
        );
      }
      const limitBytes = bucket.maxSizeGb * 1024 * 1024 * 1024;
      if (bucket.usedSizeBytes >= limitBytes) {
        throw new BadRequestException(
          `Upload blocked: Storage bucket '${bucketName}' storage limit of ${bucket.maxSizeGb} GB has been reached. Please extend bucket capacity.`,
        );
      }
    }

    const targetCollection = await this.collectionModel
      .findOne({ _id: collectionId, owner: userId as any })
      .exec();

    if (!targetCollection) {
      throw new BadRequestException('Collection not found or unauthorized');
    }

    let metadataStandard =
      metadataStandardInput || targetCollection.metadataStandard || 'arc19';

    // Compute send batch info
    const existingAssets = targetCollection.assets || [];
    const maxExistingSend = existingAssets.reduce(
      (max, a) => Math.max(max, (a as any).sendNumber || 1),
      0,
    );

    let targetSendNumber = sendNumberInput;
    if (!targetSendNumber || (existingAssets.length > 0 && targetSendNumber <= maxExistingSend)) {
      targetSendNumber = existingAssets.length > 0 ? maxExistingSend + 1 : 1;
    }
    const targetSendLabel =
      sendLabelInput && targetSendNumber === sendNumberInput
        ? sendLabelInput
        : formatSendLabel(targetSendNumber);
    const uploadedAtDate = new Date();

    let totalUploadedBytes = 0;
    // Each item does several S3 calls (HEAD with retries, metadata PUT); 2,000 at once floods Filebase.
    const registeredAssets = await mapWithConcurrency(
      items,
      16,
      async (item) => {
        const parsedMeta =
          typeof item.metadata === 'string'
            ? JSON.parse(item.metadata)
            : item.metadata;
        const assetName = parsedMeta?.name || `${collectionName} Asset`;
        const assetDescription =
          parsedMeta?.description || `Asset of ${collectionName}`;

        // 1. Resolve image CID from input or S3 HeadObject metadata
        let imageUploadResult: { key: string; cid: string; url: string; sizeBytes: number };
        if (item.imageCid) {
          imageUploadResult = {
            key: item.imageKey,
            cid: item.imageCid,
            url: this.filebaseService.getGatewayUrl(item.imageCid),
            sizeBytes: await this.filebaseService.getFileSize(userId, bucketName, item.imageKey),
          };
        } else {
          const fileMetadata = await this.filebaseService.getFileMetadata(
            userId,
            bucketName,
            item.imageKey,
          );
          imageUploadResult = {
            key: item.imageKey,
            cid: fileMetadata.cid,
            url: this.filebaseService.getGatewayUrl(fileMetadata.cid),
            sizeBytes: fileMetadata.sizeBytes,
          };
        }

        // 2. Generate NFT Metadata JSON referencing the resolved image CID
        const { traits, metadataObject } = this.extractTraitsAndMetadata(
          parsedMeta,
          assetName,
          assetDescription,
          imageUploadResult.cid,
          item.mimeType || 'image/png',
        );

        const metadataBuffer = Buffer.from(JSON.stringify(metadataObject, null, 2));
        const metadataHash = crypto
          .createHash('sha256')
          .update(metadataBuffer)
          .digest('hex');
        const metadataKey = `${item.imageKey}.json`;

        // 3. Check for matching identical metadata or upload new JSON to Filebase
        let metadataUploadResult: { key: string; cid: string; url: string; sizeBytes: number };
        metadataUploadResult = await this.filebaseService.uploadFile(
          userId,
          bucketName,
          metadataKey,
          metadataBuffer,
          'application/json',
        );

        const itemTotalBytes =
          imageUploadResult.sizeBytes + metadataUploadResult.sizeBytes;
        totalUploadedBytes += itemTotalBytes;

        await this.filebaseService.saveCidRecord({
          cid: imageUploadResult.cid,
          bucketName,
          name: item.fileName || assetName,
          fileId: item.imageKey,
          sizeBytes: imageUploadResult.sizeBytes,
          mimeType: item.mimeType || 'image/png',
          owner: userId,
        });

        await this.filebaseService.saveCidRecord({
          cid: metadataUploadResult.cid,
          bucketName,
          name: `${assetName} Metadata`,
          fileId: metadataKey,
          sizeBytes: metadataUploadResult.sizeBytes,
          mimeType: 'application/json',
          metadata: metadataObject,
          owner: userId,
        });

        return {
          name: assetName,
          imageKey: item.imageKey,
          imageCid: imageUploadResult.cid,
          imageUrl: imageUploadResult.url,
          metadataKey,
          metadataCid: metadataUploadResult.cid,
          metadataUrl: metadataUploadResult.url,
          mimeType: item.mimeType || 'image/png',
          imageSize: imageUploadResult.sizeBytes,
          metadataSize: metadataUploadResult.sizeBytes,
          imageHash: item.imageHash,
          metadataHash,
          sendNumber: targetSendNumber,
          sendLabel: targetSendLabel,
          uploadedAt: uploadedAtDate,
        };
      },
    );

    if (totalUploadedBytes > 0) {
      await this.bucketModel
        .updateOne(
          { _id: bucket._id },
          { $inc: { usedSizeBytes: totalUploadedBytes } },
        )
        .exec();

      await this.userModel
        .updateOne(
          { _id: userId },
          { $inc: { usedStorageBytes: totalUploadedBytes } },
        )
        .exec();
    }

    const res = await this.collectionModel
      .updateOne(
        { _id: collectionId, owner: userId as any },
        { $push: { assets: { $each: registeredAssets } } },
      )
      .exec();

    if (res.matchedCount === 0) {
      throw new BadRequestException('Collection not found or unauthorized');
    }

    return registeredAssets;
  }

  async verifyMetadataBulk(
    items: Array<{ name: string; metadataCid?: string; metadataUrl?: string; description?: string }>,
  ): Promise<Array<{ asset: any; properties: Record<string, any>; description: string }>> {
    const concurrency = 20;
    const results = new Array(items.length);
    let index = 0;

    const fetchSingle = async (item: any) => {
      let properties: Record<string, any> = {};
      let description = item.description || `Asset of ${item.name}`;

      const cid = item.metadataCid;

      // 1. Check MongoDB first for cached/generated CID record
      if (cid) {
        try {
          const dbRecord = await this.filebaseService.findCidRecord(cid);
          if (dbRecord && dbRecord.metadata) {
            const metadata = dbRecord.metadata;
            description = metadata.description || description;
            if (metadata.properties?.traits && typeof metadata.properties.traits === 'object') {
              Object.assign(properties, metadata.properties.traits);
            } else if (metadata.traits && typeof metadata.traits === 'object' && !Array.isArray(metadata.traits)) {
              Object.assign(properties, metadata.traits);
            }
            if (Array.isArray(metadata.attributes || metadata.traits)) {
              const attrs = metadata.attributes || metadata.traits;
              attrs.forEach((a: any) => {
                const tType = a?.trait_type || a?.traitType || a?.name || a?.key;
                if (a && tType && a.value !== undefined) {
                  properties[tType] = a.value;
                }
              });
            }
            return {
              asset: item,
              properties,
              description,
            };
          }
        } catch (err) {
          // Fallback to HTTP gateway if DB lookup fails
        }
      }

      // 2. Fallback to HTTP gateways if not found in MongoDB
      const gatewayUrls = cid
        ? this.filebaseService.getGatewayUrlsForCid(cid)
        : item.metadataUrl
          ? [item.metadataUrl]
          : [];

      if (item.metadataUrl && !gatewayUrls.includes(item.metadataUrl)) {
        gatewayUrls.push(item.metadataUrl);
      }

      let fetchedSuccess = false;
      for (const url of gatewayUrls) {
        if (fetchedSuccess) break;
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 3500);

          const res = await fetch(url, { signal: controller.signal });
          clearTimeout(timeoutId);

          if (res.ok) {
            const metadata = await res.json();
            description = metadata.description || description;
            if (metadata.properties?.traits && typeof metadata.properties.traits === 'object') {
              Object.assign(properties, metadata.properties.traits);
            } else if (metadata.traits && typeof metadata.traits === 'object' && !Array.isArray(metadata.traits)) {
              Object.assign(properties, metadata.traits);
            }
            if (Array.isArray(metadata.attributes || metadata.traits)) {
              const attrs = metadata.attributes || metadata.traits;
              attrs.forEach((a: any) => {
                const tType = a?.trait_type || a?.traitType || a?.name || a?.key;
                if (a && tType && a.value !== undefined) {
                  properties[tType] = a.value;
                }
              });
            }
            fetchedSuccess = true;

            // Cache retrieved metadata in MongoDB
            if (cid) {
              this.filebaseService.saveCidRecord({
                cid,
                bucketName: 'algofile-bucket-free',
                name: `${item.name} Metadata`,
                fileId: `${item.name}.json`,
                mimeType: 'application/json',
                metadata,
              });
            }
          }
        } catch {
          // Try next gateway fallback silently
        }
      }

      return {
        asset: item,
        properties,
        description,
      };
    };

    const worker = async () => {
      while (index < items.length) {
        const curIdx = index++;
        const item = items[curIdx];
        results[curIdx] = await fetchSingle(item);
      }
    };

    const workers = Array.from(
      { length: Math.min(concurrency, items.length) },
      worker,
    );
    await Promise.all(workers);

    return results;
  }

  async updateMetadataBulk(
    userId: string,
    collectionId: string,
    sendNumber: number | null | undefined,
    items: Array<{ fileName: string; metadata: any }>,
  ): Promise<{
    updatedCount: number;
    unmatchedCount: number;
    updatedAssets: any[];
    unmatchedFiles: string[];
  }> {
    const targetCollection = await this.collectionModel
      .findOne({ _id: collectionId, owner: userId as any })
      .exec();

    if (!targetCollection) {
      throw new BadRequestException('Collection not found or unauthorized');
    }

    const allAssets = targetCollection.assets || [];
    if (allAssets.length === 0) {
      throw new BadRequestException('The selected collection contains no assets');
    }

    const targetAssets =
      sendNumber && sendNumber > 0
        ? allAssets.filter((a: any) => a.sendNumber === sendNumber)
        : allAssets;

    if (targetAssets.length === 0) {
      throw new BadRequestException(
        `No assets found in Send #${sendNumber} for this collection`,
      );
    }

    const bucketName = targetCollection.bucketName;
    const updatedAssets: any[] = [];
    const unmatchedFiles: string[] = [];

    const concurrency = 10;
    let nextIdx = 0;

    const worker = async () => {
      while (nextIdx < items.length) {
        const cur = items[nextIdx++];
        const rawFileName = cur.fileName ? cur.fileName.trim() : '';
        if (!rawFileName) continue;

        const cleanFileName = rawFileName.toLowerCase();
        const baseNameNoExt = cleanFileName
          .replace(/\.json$/i, '')
          .replace(/\.[^/.]+$/, '');

        const parsedMetaTemp =
          typeof cur.metadata === 'string'
            ? JSON.parse(cur.metadata)
            : cur.metadata || {};

        const metaInnerName = (parsedMetaTemp.name || '').trim().toLowerCase();
        const fileIndexMatch = baseNameNoExt.match(/(?:idx|_|-|#)?(\d+)(?:\.[^/.]+)?$/i);
        const fileIndexNum = fileIndexMatch ? fileIndexMatch[1] : null;

        const matchedAsset = targetAssets.find((a: any) => {
          const assetName = (a.name || '').trim().toLowerCase();
          const assetFileName = (a.fileName || '').trim().toLowerCase();
          const metaKey = (a.metadataKey || '').toLowerCase();
          const imgKey = (a.imageKey || '').toLowerCase();

          // 1. Direct match on inner JSON name
          if (metaInnerName && (assetName === metaInnerName || assetFileName === metaInnerName)) {
            return true;
          }

          // 2. Substring match on file key (ignoring timestamp prefixes)
          if (baseNameNoExt.length > 0) {
            if (
              metaKey.includes(`_${baseNameNoExt}.`) ||
              metaKey.includes(`/${baseNameNoExt}.`) ||
              imgKey.includes(`_${baseNameNoExt}.`) ||
              imgKey.includes(`/${baseNameNoExt}.`) ||
              (baseNameNoExt.length >= 3 && (metaKey.includes(baseNameNoExt) || imgKey.includes(baseNameNoExt)))
            ) {
              return true;
            }
          }

          // 3. Match by filename without extension
          if (
            assetFileName === cleanFileName ||
            assetFileName === baseNameNoExt ||
            assetName === cleanFileName ||
            assetName === baseNameNoExt
          ) {
            return true;
          }

          // 4. Index number matching (e.g. "idx6053" matching asset "#6053")
          if (fileIndexNum) {
            const assetIndexMatch = assetName.match(/(?:#|_|-|idx)?(\d+)$/i) || assetFileName.match(/(?:#|_|-|idx)?(\d+)(?:\.[^/.]+)?$/i);
            if (assetIndexMatch && assetIndexMatch[1] === fileIndexNum) {
              return true;
            }
          }

          return false;
        });

        if (!matchedAsset) {
          unmatchedFiles.push(rawFileName);
          continue;
        }

        const parsedMeta =
          typeof cur.metadata === 'string'
            ? JSON.parse(cur.metadata)
            : cur.metadata || {};

        const assetName = parsedMeta.name || matchedAsset.name;
        const assetDescription =
          parsedMeta.description || (matchedAsset as any).description || `Asset of ${targetCollection.name}`;

        const { traits, metadataObject } = this.extractTraitsAndMetadata(
          parsedMeta,
          assetName,
          assetDescription,
          matchedAsset.imageCid,
          matchedAsset.mimeType || 'image/png',
        );

        const metadataBuffer = Buffer.from(
          JSON.stringify(metadataObject, null, 2),
        );
        const metadataHash = crypto
          .createHash('sha256')
          .update(metadataBuffer)
          .digest('hex');

        let metadataCid = (cur as any).metadataCid;
        let metadataKey = (cur as any).metadataKey || matchedAsset.metadataKey;
        let metadataUrl = metadataCid ? `https://algofile.myfilebase.com/ipfs/${metadataCid}` : '';

        if (!metadataCid) {
          const metadataUploadResult = await this.filebaseService.uploadFile(
            userId,
            bucketName,
            metadataKey,
            metadataBuffer,
            'application/json',
          );
          metadataCid = metadataUploadResult.cid;
          metadataUrl = metadataUploadResult.url;
        }

        matchedAsset.metadataCid = metadataCid;
        matchedAsset.metadataKey = metadataKey;
        matchedAsset.metadataUrl = metadataUrl;
        matchedAsset.metadataHash = metadataHash;
        matchedAsset.name = assetName;
        (matchedAsset as any).updatedAt = new Date();

        await this.filebaseService.saveCidRecord({
          cid: metadataCid,
          bucketName,
          name: `${assetName} Metadata`,
          fileId: metadataKey,
          sizeBytes: metadataBuffer.length,
          mimeType: 'application/json',
          metadata: metadataObject,
          owner: userId,
        });

        updatedAssets.push(matchedAsset);
      }
    };

    const workers = Array.from(
      { length: Math.min(concurrency, items.length) },
      worker,
    );
    await Promise.all(workers);

    await this.collectionModel.updateOne(
      { _id: collectionId, owner: userId as any },
      { $set: { assets: allAssets } },
    );

    return {
      updatedCount: updatedAssets.length,
      unmatchedCount: unmatchedFiles.length,
      updatedAssets,
      unmatchedFiles,
    };
  }

  async transferAssetIds(
    userId: string,
    params: {
      oldCollectionId?: string;
      oldCollectionName?: string;
      newCollectionId?: string;
      newCollectionName?: string;
      matchBy?: 'name' | 'index';
      customMappings?: Array<{
        name?: string;
        oldAssetId?: number;
        newAssetId?: number;
      }>;
      unmintOld?: boolean;
      mnemonic?: string;
      network?: 'mainnet' | 'testnet';
    },
  ): Promise<any> {
    const {
      oldCollectionId,
      oldCollectionName,
      newCollectionId,
      newCollectionName,
      matchBy = 'name',
      customMappings,
      unmintOld = true,
      mnemonic,
      network = 'mainnet',
    } = params;

    let oldCollectionQuery: any = { owner: userId as any };
    if (oldCollectionId) {
      oldCollectionQuery._id = oldCollectionId;
    } else if (oldCollectionName) {
      oldCollectionQuery.name = oldCollectionName;
    } else {
      throw new BadRequestException(
        'Either oldCollectionId or oldCollectionName must be provided',
      );
    }

    const oldCollection = await this.collectionModel
      .findOne(oldCollectionQuery)
      .exec();
    if (!oldCollection) {
      throw new BadRequestException('Old collection not found or unauthorized');
    }

    let newCollectionQuery: any = { owner: userId as any };
    if (newCollectionId) {
      newCollectionQuery._id = newCollectionId;
    } else if (newCollectionName) {
      newCollectionQuery.name = newCollectionName;
    } else {
      throw new BadRequestException(
        'Either newCollectionId or newCollectionName must be provided',
      );
    }

    const newCollection = await this.collectionModel
      .findOne(newCollectionQuery)
      .exec();
    if (!newCollection) {
      throw new BadRequestException('New collection not found or unauthorized');
    }

    if (oldCollection._id.toString() === newCollection._id.toString()) {
      throw new BadRequestException(
        'Old collection and new collection must be different',
      );
    }

    const transferredDetails: Array<{
      name: string;
      assetId: number;
      metadataCid?: string;
      newReserveAddress?: string;
      onChainTxId?: string;
    }> = [];

    const processAssetTransfer = async (
      oldAsset: any | null,
      newAsset: any,
      targetAssetId: number,
    ) => {
      if (oldAsset && unmintOld) {
        oldAsset.assetId = null;
      }
      newAsset.assetId = targetAssetId;

      let reserveAddr: string | undefined = undefined;
      if (newAsset.metadataCid) {
        try {
          reserveAddr = cidToReserveAddress(newAsset.metadataCid);
        } catch (e) {
          console.warn(
            `Failed to derive reserve address for asset ${newAsset.name}:`,
            e,
          );
        }
      }

      if (newAsset.imageCid) {
        await this.filebaseService.saveCidRecord({
          cid: newAsset.imageCid,
          bucketName: newCollection.bucketName,
          fileId: newAsset.imageKey,
          assetId: targetAssetId,
          owner: userId,
        });
      }
      if (newAsset.metadataCid) {
        await this.filebaseService.saveCidRecord({
          cid: newAsset.metadataCid,
          bucketName: newCollection.bucketName,
          fileId: newAsset.metadataKey,
          assetId: targetAssetId,
          owner: userId,
        });
      }

      transferredDetails.push({
        name: newAsset.name,
        assetId: targetAssetId,
        metadataCid: newAsset.metadataCid,
        newReserveAddress: reserveAddr,
      });
    };

    if (Array.isArray(customMappings) && customMappings.length > 0) {
      for (const mapItem of customMappings) {
        const targetName = mapItem.name;
        const targetOldAssetId = mapItem.oldAssetId;

        const newAsset = newCollection.assets.find(
          (a) =>
            (targetName && a.name === targetName) ||
            (mapItem.newAssetId && a.assetId === mapItem.newAssetId),
        );
        if (!newAsset) continue;

        const assetIdToAssign = targetOldAssetId || newAsset.assetId;
        if (!assetIdToAssign) continue;

        const oldAsset = oldCollection.assets.find(
          (a) =>
            (targetName && a.name === targetName) ||
            (targetOldAssetId && a.assetId === targetOldAssetId),
        );

        await processAssetTransfer(oldAsset, newAsset, assetIdToAssign);
      }
    } else if (matchBy === 'index') {
      const minLength = Math.min(
        oldCollection.assets.length,
        newCollection.assets.length,
      );
      for (let i = 0; i < minLength; i++) {
        const oldAsset = oldCollection.assets[i];
        const newAsset = newCollection.assets[i];

        if (oldAsset && oldAsset.assetId) {
          const inheritedAssetId = oldAsset.assetId;
          await processAssetTransfer(oldAsset, newAsset, inheritedAssetId);
        }
      }
    } else {
      const oldAssetsByName = new Map<string, any>();
      for (const oldAsset of oldCollection.assets) {
        if (oldAsset.name && oldAsset.assetId) {
          oldAssetsByName.set(oldAsset.name.trim(), oldAsset);
        }
      }

      for (const newAsset of newCollection.assets) {
        const trimmedName = newAsset.name ? newAsset.name.trim() : '';
        const matchingOldAsset = oldAssetsByName.get(trimmedName);

        if (matchingOldAsset && matchingOldAsset.assetId) {
          const inheritedAssetId = matchingOldAsset.assetId;
          await processAssetTransfer(matchingOldAsset, newAsset, inheritedAssetId);
        }
      }
    }

    let onChainBroadcastCount = 0;
    if (mnemonic && transferredDetails.length > 0) {
      try {
        const secretKeyAccount = algosdk.mnemonicToSecretKey(mnemonic.trim());
        const nodelyUrl =
          network === 'testnet'
            ? 'https://testnet-api.4160.nodely.dev'
            : 'https://mainnet-api.4160.nodely.dev';
        const client = new algosdk.Algodv2('', nodelyUrl, '');

        const suggestedParams = await client.getTransactionParams().do();
        const atomicGroupSize = 16;

        for (let i = 0; i < transferredDetails.length; i += atomicGroupSize) {
          const batch = transferredDetails.slice(i, i + atomicGroupSize);
          const groupTxns: any[] = [];

          for (const item of batch) {
            if (!item.newReserveAddress) continue;

            const txn = algosdk.makeAssetConfigTxnWithSuggestedParamsFromObject({
              sender: secretKeyAccount.addr,
              assetIndex: Number(item.assetId),
              manager: secretKeyAccount.addr,
              reserve: item.newReserveAddress,
              freeze: undefined,
              clawback: undefined,
              strictEmptyAddressChecking: false,
              suggestedParams,
            });
            groupTxns.push({ txn, item });
          }

          if (groupTxns.length > 0) {
            const rawTxns = groupTxns.map((g) => g.txn);
            if (rawTxns.length > 1) {
              algosdk.assignGroupID(rawTxns);
            }

            const signedGroup = rawTxns.map((t) => t.signTxn(secretKeyAccount.sk));
            const sendResult = await client.sendRawTransaction(signedGroup).do();
            const txId = (sendResult as any).txId || sendResult.txid;
            await algosdk.waitForConfirmation(client, txId, 4);

            groupTxns.forEach((g) => {
              g.item.onChainTxId = txId;
              onChainBroadcastCount++;
            });
          }
        }
      } catch (chainErr: any) {
        console.error(
          'Failed to execute on-chain AssetConfig transactions:',
          chainErr,
        );
      }
    }

    await this.collectionModel.updateOne(
      { _id: oldCollection._id },
      { $set: { assets: oldCollection.assets } },
    );
    await this.collectionModel.updateOne(
      { _id: newCollection._id },
      { $set: { assets: newCollection.assets } },
    );

    return {
      message: `Successfully transferred ${transferredDetails.length} asset IDs from '${oldCollection.name}' to '${newCollection.name}'${
        onChainBroadcastCount > 0
          ? ` and updated ${onChainBroadcastCount} ARC-19 Reserve addresses on Algorand.`
          : '.'
      }`,
      transferredCount: transferredDetails.length,
      onChainBroadcastCount,
      oldCollection: {
        id: oldCollection._id.toString(),
        name: oldCollection.name,
        totalAssets: oldCollection.assets.length,
      },
      newCollection: {
        id: newCollection._id.toString(),
        name: newCollection.name,
        totalAssets: newCollection.assets.length,
      },
      details: transferredDetails,
    };
  }
}



