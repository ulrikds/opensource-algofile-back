import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { Purchase, PurchaseDocument } from './schemas/purchase.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { Bucket, BucketDocument } from '../filebase/schemas/bucket.schema';
import { PaidUpload, PaidUploadDocument } from './schemas/paid-upload.schema';
import { ApiKeyLog, ApiKeyLogDocument } from './schemas/api-key-log.schema';
import { ConfigService } from '@nestjs/config';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import * as algosdk from 'algosdk';
import { X402Service, X402PaymentRequirements, declareDiscoveryExtension, ProjectMetadataResolver } from '../x402/x402.service';
import { PRICING_CONFIG } from '../config/pricing.config';

@Injectable()
export class PurchasesService {
  private readonly receiverWallet: string;
  private readonly network: string;
  private readonly usdcAssetId: number;
  private readonly s3Client: S3Client;

  constructor(
    @InjectModel(Purchase.name) private purchaseModel: Model<PurchaseDocument>,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    @InjectModel(Bucket.name) private bucketModel: Model<BucketDocument>,
    @InjectModel(PaidUpload.name)
    private paidUploadModel: Model<PaidUploadDocument>,
    @InjectModel(ApiKeyLog.name)
    private apiKeyLogModel: Model<ApiKeyLogDocument>,
    private configService: ConfigService,
    private x402Service: X402Service,
  ) {
    this.receiverWallet =
      this.configService.get<string>('ALGORAND_RECEIVER_WALLET') ||
      this.configService.get<string>('AVM_ADDRESS') ||
      this.configService.get<string>('RECEIVER_WALLET') ||
      'IYYLWNTA7QNG7SJOBKEGSBHQ3KENT6RKOWH4AMIBYR7Y2WF4B4KCIJ6WQQ';
    this.network =
      this.configService.get<string>('ALGORAND_NETWORK') || 'testnet';

    // USDC Asset ID: Testnet = 10458941, Mainnet = 31566704
    this.usdcAssetId =
      this.network.toLowerCase() === 'mainnet' ? 31566704 : 10458941;

    const endpoint =
      this.configService.get<string>('FILEBASE_ENDPOINT') ||
      'https://s3.filebase.io';
    const accessKeyId = this.configService.get<string>(
      'FILEBASE_ACCESS_KEY_ID',
    );
    const secretAccessKey = this.configService.get<string>(
      'FILEBASE_SECRET_ACCESS_KEY',
    );

    this.s3Client = new S3Client({
      endpoint,
      region: 'auto',
      credentials: {
        accessKeyId: accessKeyId || 'placeholder-key',
        secretAccessKey: secretAccessKey || 'placeholder-secret',
      },
      forcePathStyle: true,
    });
  }

  private readonly logger = new Logger(PurchasesService.name);
  private cachedAlgoPrice: number | null = null;
  private lastPriceFetchTime: number = 0;

  private logToFile(message: string) {
    if (message.startsWith('[ERROR]')) {
      this.logger.error(message);
    } else if (message.startsWith('[WARNING]')) {
      this.logger.warn(message);
    } else {
      this.logger.log(message);
    }
  }

  /**
   * Fetches the current ALGO price in USD
   */
  async getAlgoPriceUsd(): Promise<number> {
    const now = Date.now();
    // Cache price for 60 seconds to prevent node spamming
    if (
      this.cachedAlgoPrice !== null &&
      now - this.lastPriceFetchTime < 60000
    ) {
      return this.cachedAlgoPrice;
    }

    try {
      const response = await fetch(
        'https://mainnet-api.4160.nodely.dev/v2/accounts/NGIHJMECRSFHIEQDHBVTLR54K7DOZWM5M6UM3A5CIOYSP6H3QTGSHHGJCQ',
      );
      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}`);
      }
      const data = await response.json();

      const algoBalance = data?.amount || 0;
      const assets = data?.assets || [];

      // Find USDC (Asset ID 31566704)
      const usdcAsset = assets.find((a: any) => a?.['asset-id'] === 31566704);
      const usdcBalance = usdcAsset ? usdcAsset.amount : 0;

      const numAlgo = Number(algoBalance);
      const numUsdc = Number(usdcBalance);

      if (numAlgo > 0 && numUsdc > 0) {
        // Both USDC and ALGO have 6 decimals, so the raw balance ratio is the price
        const price = numUsdc / numAlgo;
        if (price > 0 && price < 100) {
          // sanity check
          this.cachedAlgoPrice = parseFloat(price.toFixed(6));
          this.lastPriceFetchTime = now;
          return this.cachedAlgoPrice;
        }
      }
      throw new Error(
        `Invalid balances fetched from Pact pool (ALGO: ${algoBalance}, USDC: ${usdcBalance})`,
      );
    } catch (error) {
      console.warn(
        'Could not fetch ALGO price from Pact pool via REST, using fallback rate of 0.15 USD',
        error.message,
      );
      if (this.cachedAlgoPrice !== null) {
        return this.cachedAlgoPrice;
      }
      return 0.15; // Fallback rate
    }
  }

  /**
   * Calculates plan prices in USD, ALGO, and USDC
   */
  async getPlanPrices() {
    const algoPrice = await this.getAlgoPriceUsd();

    const calculateTiers = (gb: number) => {
      // Proportional rate per GB per month from PRICING_CONFIG
      const durations = [6, 12, 24];
      return durations.map((months) => {
        const priceUsd = gb * months * PRICING_CONFIG.BUCKET_STORAGE_RATE_PER_GB_MONTH;
        return {
          months,
          priceUsd,
          priceUsdc: priceUsd, // 1 USDC = 1 USD
          priceAlgo: parseFloat((priceUsd / algoPrice).toFixed(2)),
        };
      });
    };

    const calculate50MbTiers = () => {
      const durations = [6, 12, 24];
      return durations.map((months) => {
        const priceUsd = PRICING_CONFIG.PLAN_50MB_PRICE_USD;
        return {
          months,
          priceUsd,
          priceUsdc: priceUsd,
          priceAlgo: parseFloat((priceUsd / algoPrice).toFixed(2)),
        };
      });
    };

    return {
      network: this.network,
      usdcAssetId: this.usdcAssetId,
      receiverWallet: this.receiverWallet,
      algoPriceUsd: algoPrice,
      tiers: {
        '10gb': calculateTiers(10),
        '25gb': calculateTiers(25),
        '50gb': calculateTiers(50),
        '50mb': calculate50MbTiers(),
      },
    };
  }

  /**
   * Verifies an Algorand transaction ID and provisions the storage bucket
   */
  async verifyPurchase(
    userId: string,
    txId: string,
    planType: string,
    durationMonths: number,
    customPriceUsd?: number,
    customGb?: number,
    bucketName?: string,
    mintType?: string,
  ): Promise<Purchase> {
    this.logToFile(
      `[START] Verification initiated for User: ${userId}, TxID: ${txId}, Capacity: ${planType}, Duration: ${durationMonths} months, RenewBucket: ${bucketName || 'none'}`,
    );

    // 1. Verify inputs
    const validPlans = ['10gb', '25gb', '50gb', 'custom', '50mb'];
    const validDurations = [6, 12, 24];

    if (!validPlans.includes(planType)) {
      const errMsg = `Invalid plan type: ${planType}`;
      this.logToFile(`[ERROR] ${errMsg}`);
      throw new BadRequestException(errMsg);
    }
    if (!validDurations.includes(durationMonths)) {
      const errMsg = `Invalid duration: ${durationMonths} months`;
      this.logToFile(`[ERROR] ${errMsg}`);
      throw new BadRequestException(errMsg);
    }

    let user: any = null;
    if (isValidObjectId(userId)) {
      user = await this.userModel.findById(userId);
    }
    if (!user) {
      user = await this.userModel.findOne({ email: 'x402-public@algofile.io' });
      if (!user) {
        user = await this.userModel.create({
          googleId: 'x402-public-google-id',
          email: 'x402-public@algofile.io',
          displayName: 'x402 Public Buyer',
          role: 'user',
        });
      }
    }
    const effectiveUserId = user._id.toString();

    // Limit to 5 active storage buckets per user (except for custom memory plans)
    if (!bucketName && planType !== 'custom') {
      const bucketCount = await this.bucketModel
        .countDocuments({
          owner: effectiveUserId as any,
          $or: [
            { expiresAt: { $gt: new Date() } },
            { expiresAt: null },
          ],
        })
        .exec();
      if (bucketCount >= 5) {
        const errMsg =
          'You have reached the limit of 5 active storage buckets. Please renew an existing bucket instead.';
        this.logToFile(`[ERROR] ${errMsg}`);
        throw new BadRequestException(errMsg);
      }
    }

    const userNetwork = 'mainnet';

    // 2. Check for double spend
    const existing = await this.purchaseModel.findOne({ txId }).exec();
    if (existing) {
      const errMsg = `Transaction ID ${txId} has already been verified and processed.`;
      this.logToFile(`[ERROR] ${errMsg}`);
      throw new BadRequestException(errMsg);
    }

    // 3. Calculate expected USD price
    let gb =
      planType === '10gb'
        ? 10
        : planType === '25gb'
          ? 25
          : planType === '50gb'
            ? 50
            : 10;
    if (planType === '50mb') {
      gb = 0.05; // 50MB is 0.05 GB
    }
    if (planType === 'custom' && customGb !== undefined) {
      gb = customGb;
    }
    let expectedPriceUsd = gb * durationMonths * 0.2;
    if (planType === '50mb') {
      expectedPriceUsd = 12.0;
    }
    if (planType === 'custom' && customPriceUsd !== undefined) {
      expectedPriceUsd = customPriceUsd;
    }

    // 4. Fetch Algorand transaction details from Indexer API (Always Mainnet for bucket purchases)
    const baseUrl = 'https://mainnet-idx.4160.nodely.dev';

    this.logToFile(
      `[INFO] Fetching transaction from indexer: ${baseUrl}/v2/transactions/${txId}`,
    );
    let txData: any;
    let attempts = 0;
    const maxAttempts = 6;
    while (attempts < maxAttempts) {
      try {
        const response = await fetch(`${baseUrl}/v2/transactions/${txId}`);
        if (response.ok) {
          const data = await response.json();
          txData = data?.transaction;
          if (txData) {
            this.logToFile(
              `[INFO] Transaction payload retrieved from indexer on attempt ${attempts + 1}.`,
            );
            break;
          }
        } else if (response.status !== 404) {
          throw new Error(`HTTP ${response.status}`);
        }
      } catch (error) {
        this.logToFile(
          `[WARNING] Attempt ${attempts + 1} to query indexer failed: ${error.message}`,
        );
      }
      attempts++;
      if (attempts < maxAttempts && !txData) {
        this.logToFile(
          `[INFO] Transaction not indexed yet. Retrying in 2 seconds...`,
        );
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    if (!txData) {
      const errMsg = `Transaction details for TxID ${txId} not found on the blockchain (Indexer query timed out).`;
      this.logToFile(`[ERROR] ${errMsg}`);
      throw new BadRequestException(errMsg);
    }

    // Check transaction age to prevent historical replay attacks
    const roundTime = txData['round-time'] || txData['roundTime'];
    if (!roundTime) {
      const errMsg = `Could not determine transaction block time.`;
      this.logToFile(`[ERROR] ${errMsg}`);
      throw new BadRequestException(errMsg);
    }
    const txTimeMs = roundTime * 1000;
    const ageMs = Date.now() - txTimeMs;
    const maxAgeMs = 2 * 60 * 60 * 1000; // 2 hours
    if (ageMs > maxAgeMs) {
      const errMsg = `Transaction ${txId} is too old (confirmed ${new Date(txTimeMs).toLocaleString()}). Recent payments (last 2 hours) are required.`;
      this.logToFile(`[ERROR] ${errMsg}`);
      throw new BadRequestException(errMsg);
    }

    // 5. Inspect transaction details
    const txType = txData['tx-type'];
    let paidAmount = 0;
    let receiver = '';
    let currency = '';
    const sender = txData['sender'];

    this.logToFile(
      `[INFO] Transaction inspection details -> Sender: ${sender}, Type: ${txType}`,
    );

    if (txType === 'pay') {
      // Native ALGO payment
      currency = 'ALGO';
      receiver = txData['payment-transaction']?.['receiver'];
      paidAmount = txData['payment-transaction']?.['amount'] / 1_000_000; // MicroAlgos to ALGO
    } else if (txType === 'axfer') {
      // Asset transfer (should be USDC)
      const assetId = txData['asset-transfer-transaction']?.['asset-id'];
      const userUsdcAssetId = 31566704; // Mainnet USDC
      if (assetId !== userUsdcAssetId) {
        const errMsg = `Invalid asset ID paid: ${assetId}. Expected USDC (${userUsdcAssetId})`;
        this.logToFile(`[ERROR] ${errMsg}`);
        throw new BadRequestException(errMsg);
      }
      currency = 'USDC';
      receiver = txData['asset-transfer-transaction']?.['receiver'];
      paidAmount = txData['asset-transfer-transaction']?.['amount'] / 1_000_000; // MicroUSDC to USDC
    } else {
      const errMsg = `Unsupported transaction type: ${txType}. Must be 'pay' (ALGO) or 'axfer' (USDC).`;
      this.logToFile(`[ERROR] ${errMsg}`);
      throw new BadRequestException(errMsg);
    }

    this.logToFile(
      `[INFO] Payment data -> Receiver: ${receiver}, Paid Amount: ${paidAmount} ${currency}`,
    );

    // Verify receiver matches the configured wallet address
    if (receiver.toUpperCase() !== this.receiverWallet.toUpperCase()) {
      const errMsg = `Incorrect receiver address. Transaction sent to ${receiver}, expected ${this.receiverWallet}`;
      this.logToFile(`[ERROR] ${errMsg}`);
      throw new BadRequestException(errMsg);
    }

    // 6. Verify amount
    if (currency === 'USDC') {
      // USDC is 1-to-1 with USD
      if (paidAmount < expectedPriceUsd - 0.01) {
        const errMsg = `Paid amount of ${paidAmount} USDC is less than the expected price of ${expectedPriceUsd} USD.`;
        this.logToFile(`[ERROR] ${errMsg}`);
        throw new BadRequestException(errMsg);
      }
    } else {
      // ALGO requires exchange rate verification
      const algoPrice = await this.getAlgoPriceUsd();
      const expectedAlgoAmount = expectedPriceUsd / algoPrice;
      const differencePercent =
        Math.abs(paidAmount - expectedAlgoAmount) / expectedAlgoAmount;

      this.logToFile(
        `[INFO] Exchange rate calculation -> ALGO Price: $${algoPrice}, Expected: ${expectedAlgoAmount.toFixed(2)} ALGO, Difference: ${(differencePercent * 100).toFixed(2)}%`,
      );

      // Allow 5% fluctuation tolerance for rate changes
      if (differencePercent > 0.05 && paidAmount < expectedAlgoAmount) {
        const errMsg = `Paid amount of ${paidAmount.toFixed(2)} ALGO is insufficient. Expected ~${expectedAlgoAmount.toFixed(2)} ALGO based on rate of $${algoPrice.toFixed(4)}/ALGO.`;
        this.logToFile(`[ERROR] ${errMsg}`);
        throw new BadRequestException(errMsg);
      }
    }

    const description =
      planType === 'custom'
        ? `Algofile: Buying custom bucket (${gb} GB)`
        : `Algofile: Buying storage bucket (${gb} GB)`;

    // 7. Success! Save purchase log
    const purchase = await this.purchaseModel.create({
      user: effectiveUserId as any,
      txId,
      amount: paidAmount,
      currency,
      planType,
      durationMonths,
      priceUsd: expectedPriceUsd,
      senderAddress: sender,
      description,
      network: userNetwork,
    });

    // If it's custom memory, create a PaidUpload record so it shows up in the explorer
    if (planType === 'custom') {
      const targetBucket = await this.bucketModel
        .findOne({ name: 'algofilerouteapi' })
        .exec();
      if (targetBucket) {
        await this.paidUploadModel.create({
          owner: effectiveUserId as any,
          bucket: targetBucket._id as any,
          fileName:
            mintType === 'collection'
              ? 'Collection Mint'
              : mintType === 'asset'
                ? 'Single Asset Mint'
                : 'Custom Memory (Mint)',
          fileSizeGb: gb,
          amountPaidUsd: expectedPriceUsd,
          currency,
          txId,
          uploaderAddress: sender,
          network: userNetwork,
          durationMonths: durationMonths,
          mintType: mintType || 'asset',
        });
      }
    }

    // 8. Record the latest purchase info on the user profile

    let newExpiry = new Date();
    // If user has an active plan of the same type, extend it
    if (
      user.planExpiresAt &&
      user.planExpiresAt > new Date() &&
      user.planType === planType
    ) {
      newExpiry = new Date(user.planExpiresAt.getTime());
    }
    newExpiry.setMonth(newExpiry.getMonth() + durationMonths);

    user.planType = planType;
    user.storageLimitGb = gb;
    user.planExpiresAt = newExpiry;
    user.peraWalletAddress = sender;
    await user.save();

    // Create or renew the bucket for the user (except for custom memory planType === 'custom')
    if (planType !== 'custom') {
      if (bucketName) {
        await this.renewUserBucket(bucketName, effectiveUserId, durationMonths);
      } else {
        await this.createUserBucket(effectiveUserId, planType, gb, durationMonths);
      }
    }

    this.logToFile(
      `[SUCCESS] Verified TxID ${txId}. Purchased/renewed bucket for User ${effectiveUserId} with ${planType} (${gb}GB) expiring at ${newExpiry.toISOString()}, RenewBucket: ${bucketName || 'none'}`,
    );
    return purchase;
  }

  async createUserBucket(
    userId: string,
    planType: string,
    gb: number,
    durationMonths: number,
  ): Promise<BucketDocument> {
    const baseName = `algofile-yourbucket-${planType}`;
    const suffix = Math.random().toString(36).substring(2, 7);
    const bucketName = `${baseName}-${suffix}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '');

    const accessKeyId = this.configService.get<string>('FILEBASE_ACCESS_KEY_ID');
    const secretAccessKey = this.configService.get<string>('FILEBASE_SECRET_ACCESS_KEY');
    const ipfsRpcToken = (accessKeyId && secretAccessKey)
      ? Buffer.from(`${accessKeyId}:${secretAccessKey}:${bucketName}`).toString('base64')
      : (this.configService.get<string>('FILEBASE_IPFS_RPC_TOKEN') || 'mock-token');

    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + durationMonths);

    const ownerId = isValidObjectId(userId) ? (userId as any) : undefined;
    const newBucket = await this.bucketModel.create({
      name: bucketName,
      owner: ownerId,
      maxSizeGb: gb,
      usedSizeBytes: 0,
      ipfsRpcToken,
      expiresAt,
    });

    this.logToFile(
      `[INFO] Created custom bucket record '${bucketName}' in MongoDB with limit ${gb} GB and expiration ${expiresAt.toISOString()}.`,
    );
    return newBucket;
  }

  async renewUserBucket(
    bucketName: string,
    userId: string,
    durationMonths: number,
  ): Promise<BucketDocument> {
    const ownerId = isValidObjectId(userId) ? (userId as any) : undefined;
    const query: any = { name: bucketName };
    if (ownerId) query.owner = ownerId;

    const bucket = await this.bucketModel.findOne(query).exec();
    if (!bucket) {
      throw new BadRequestException(
        `Bucket '${bucketName}' not found or you are not the owner.`,
      );
    }

    let newExpiry = new Date();
    if (bucket.expiresAt && new Date(bucket.expiresAt) > new Date()) {
      newExpiry = new Date(bucket.expiresAt);
    }
    newExpiry.setMonth(newExpiry.getMonth() + durationMonths);

    bucket.expiresAt = newExpiry;
    await bucket.save();

    this.logToFile(
      `[SUCCESS] Renewed bucket '${bucketName}' for User: ${userId} to new expiry: ${newExpiry.toISOString()}`,
    );
    return bucket;
  }

  /**
   * Verifies an x402 V2 payment payload via Facilitator and provisions storage bucket
   */
  async verifyX402Purchase(
    userId: string,
    x402Payload: any,
    planType: string,
    durationMonths: number,
    currency: string = 'USDC',
    customPriceUsd?: number,
    customGb?: number,
    bucketName?: string,
    mintType?: string,
    projectName?: string,
    projectDescription?: string,
    projectIcon?: string,
  ): Promise<Purchase> {
    this.logToFile(
      `[START x402] Purchase verification initiated for User: ${userId}, Plan: ${planType}, Duration: ${durationMonths}m, RenewBucket: ${bucketName || 'none'}`,
    );

    const validPlans = ['10gb', '25gb', '50gb', 'custom', '50mb'];
    const validDurations = [6, 12, 24];

    if (!validPlans.includes(planType)) {
      throw new BadRequestException(`Invalid plan type: ${planType}`);
    }
    if (!validDurations.includes(durationMonths)) {
      throw new BadRequestException(
        `Invalid duration: ${durationMonths} months`,
      );
    }

    let user: any = null;
    if (isValidObjectId(userId)) {
      user = await this.userModel.findById(userId);
    }

    // Try finding/creating user by signed transaction sender wallet address
    const senderWallet = this.x402Service.extractSenderFromPayload(x402Payload);
    if (user && senderWallet && !user.peraWalletAddress) {
      user.peraWalletAddress = senderWallet;
      await user.save();
    }
    if (!user && senderWallet) {
      user = await this.userModel.findOne({ peraWalletAddress: senderWallet });
      if (!user) {
        user = await this.userModel.create({
          googleId: `wallet-${senderWallet}`,
          email: `${senderWallet.substring(0, 10).toLowerCase()}@wallet.algofile.io`,
          displayName: `Wallet ${senderWallet.substring(0, 6)}...`,
          peraWalletAddress: senderWallet,
          role: 'user',
        });
      }
    }

    if (!user) {
      user = await this.userModel.findOne({ email: 'x402-public@algofile.io' });
      if (!user) {
        user = await this.userModel.create({
          googleId: 'x402-public-google-id',
          email: 'x402-public@algofile.io',
          displayName: 'x402 Public Buyer',
          role: 'user',
        });
      }
    }
    const effectiveUserId = user._id.toString();

    // Limit to 5 active storage buckets per user/wallet (except for custom memory plans)
    if (!bucketName && planType !== 'custom') {
      const bucketCount = await this.bucketModel
        .countDocuments({
          owner: effectiveUserId as any,
          $or: [
            { expiresAt: { $gt: new Date() } },
            { expiresAt: null },
          ],
        })
        .exec();
      if (bucketCount >= 5) {
        throw new BadRequestException(
          'You have reached the limit of 5 active storage buckets. Please renew an existing bucket instead.',
        );
      }
    }

    const userNetwork = 'mainnet';

    let gb =
      planType === '10gb'
        ? 10
        : planType === '25gb'
          ? 25
          : planType === '50gb'
            ? 50
            : 10;
    if (planType === '50mb') gb = 0.05;
    if (planType === 'custom' && customGb !== undefined) gb = customGb;

    let expectedPriceUsd = gb * durationMonths * 0.2;
    if (planType === '50mb') expectedPriceUsd = 12.0;
    if (planType === 'custom' && customPriceUsd !== undefined)
      expectedPriceUsd = customPriceUsd;

    let amountAtomic = Math.round(expectedPriceUsd * 1_000_000).toString();
    const userUsdcAssetId = 31566704; // Mainnet USDC
    let assetId = userUsdcAssetId.toString();

    if (currency.toUpperCase() === 'ALGO') {
      const algoPrice = await this.getAlgoPriceUsd();
      const expectedAlgo = expectedPriceUsd / algoPrice;
      amountAtomic = Math.round(expectedAlgo * 1_000_000).toString();
      assetId = '0';
    }

    const caip2Network = this.x402Service.getCaip2Network('mainnet');

    const backendUrl =
      this.configService.get<string>('BACKEND_URL') || 'https://api.algofile.io';

    const requirements: X402PaymentRequirements = this.x402Service.createRequirements({
      url: `${backendUrl}/api/v3/purchases/x402-verify`,
      amount: amountAtomic,
      asset: assetId,
      payTo: this.receiverWallet,
      network: caip2Network,
      tag: 'x402-global-challenge',
      extra: {
        tag: 'x402-global-challenge',
        planType,
        capacityGb: gb,
        durationMonths,
        isCustomStorage: planType === 'custom',
      },
    });

    const resolvedMeta = ProjectMetadataResolver.resolve({
      projectName,
      projectDescription,
      projectIcon,
      planType,
      capacityGb: gb,
      durationMonths,
      x402PayloadResource: x402Payload?.resource,
    });

    if (x402Payload) {
      if (!x402Payload.resource) {
        x402Payload.resource = {};
      }
      x402Payload.resource.serviceName = resolvedMeta.name;
      x402Payload.resource.description = resolvedMeta.description;
      x402Payload.resource.iconUrl = resolvedMeta.iconUrl;
    }

    const bazaarExtension = ProjectMetadataResolver.buildBazaarExtension({
      projectName: resolvedMeta.name,
      projectDescription: resolvedMeta.description,
      projectIcon: resolvedMeta.iconUrl,
      tag: resolvedMeta.tag,
      method: 'POST',
      bodyType: 'json',
      input: { planType, durationMonths, capacityGb: gb },
      output: { txId: 'ABC...', bucketName: 'algofile-bucket-1' },
    });

    const settleResult = await this.x402Service.verifyAndSettle(
      x402Payload,
      requirements,
      bazaarExtension,
    );
    const txId = settleResult.txId;

    const existing = await this.purchaseModel.findOne({ txId }).exec();
    if (existing) {
      return existing;
    }

    const description =
      planType === 'custom'
        ? `Algofile: Buying custom bucket (${gb} GB)`
        : `Algofile: Buying storage bucket (${gb} GB)`;

    const extractedSender = this.x402Service.extractSenderFromPayload(x402Payload);
    let uploaderAddress = user.peraWalletAddress || 'unknown';
    if (extractedSender && extractedSender !== this.receiverWallet) {
      uploaderAddress = extractedSender;
    }

    if (uploaderAddress === this.receiverWallet && user.peraWalletAddress && user.peraWalletAddress !== this.receiverWallet) {
      uploaderAddress = user.peraWalletAddress;
    }

    const purchase = await this.purchaseModel.create({
      user: effectiveUserId as any,
      txId,
      amount: expectedPriceUsd,
      currency,
      planType,
      durationMonths,
      priceUsd: expectedPriceUsd,
      senderAddress: uploaderAddress,
      description,
      network: userNetwork,
    });

    // If it's custom memory, create a PaidUpload record so it shows up in the explorer
    if (planType === 'custom') {
      const targetBucket = await this.bucketModel
        .findOne({ name: 'algofilerouteapi' })
        .exec();
      if (targetBucket) {
        await this.paidUploadModel.create({
          owner: effectiveUserId as any,
          bucket: targetBucket._id as any,
          fileName:
            mintType === 'collection'
              ? 'Collection Mint'
              : mintType === 'asset'
                ? 'Single Asset Mint'
                : 'Custom Memory (Mint)',
          fileSizeGb: gb,
          amountPaidUsd: expectedPriceUsd,
          currency,
          txId,
          uploaderAddress,
          network: userNetwork,
          durationMonths: durationMonths,
          mintType: mintType || 'asset',
        });
      }
    }

    let newExpiry = new Date();
    if (
      user.planExpiresAt &&
      user.planExpiresAt > new Date() &&
      user.planType === planType
    ) {
      newExpiry = new Date(user.planExpiresAt.getTime());
    }
    newExpiry.setMonth(newExpiry.getMonth() + durationMonths);

    user.planType = planType;
    user.storageLimitGb = gb;
    user.planExpiresAt = newExpiry;
    await user.save();

    // Create or renew the bucket for the user (except for custom memory planType === 'custom')
    if (planType !== 'custom') {
      if (bucketName) {
        await this.renewUserBucket(bucketName, effectiveUserId, durationMonths);
      } else {
        await this.createUserBucket(effectiveUserId, planType, gb, durationMonths);
      }
    }
    return purchase;
  }

  getReceiverWallet(): string {
    return this.receiverWallet;
  }

  getUsdcAssetId(): number {
    return this.usdcAssetId;
  }

  getNetwork(): string {
    return this.network;
  }

  async getPaidUploadsForUser(userId: string) {
    const user = await this.userModel.findById(userId).exec();
    const isAdmin = user && user.role === 'admin';

    let query: any = { owner: userId as any };

    if (isAdmin) {
      const officialBuckets = await this.bucketModel
        .find({
          name: {
            $in: [
              'algofilerouteapi',
              'algofilerouteapi6m',
              'algofilerouteapi1y',
              'algofilerouteapi2y',
            ],
          },
        })
        .exec();
      const officialBucketIds = officialBuckets.map((b) => b._id);
      if (officialBucketIds.length > 0) {
        query = {
          $or: [
            { owner: userId as any },
            { bucket: { $in: officialBucketIds } },
          ],
        };
      }
    }

    const records = await this.paidUploadModel
      .find({
        ...query,
        network: { $ne: 'testnet' },
      })
      .populate('bucket')
      .populate('apiKey')
      .sort({ createdAt: -1 })
      .exec();

    const totalUploads = records.length;
    const totalGb = records.reduce((acc, r) => acc + (r.fileSizeGb || 0), 0);
    const totalEarnedUsd = records.reduce(
      (acc, r) => acc + (r.amountPaidUsd || 0),
      0,
    );

    return {
      records,
      stats: {
        totalUploads,
        totalGb: parseFloat(totalGb.toFixed(6)),
        totalEarnedUsd: parseFloat(totalEarnedUsd.toFixed(2)),
      },
    };
  }

  async recordPaidUpload(data: {
    ownerId: string;
    apiKeyId: string;
    bucketId: string;
    fileName: string;
    fileSizeGb: number;
    amountPaidUsd: number;
    currency: string;
    txId: string;
    uploaderAddress: string;
    network?: string;
    durationMonths?: number;
    mintType?: string;
    projectUrl?: string;
  }) {
    try {
      return await this.paidUploadModel.create({
        owner: isValidObjectId(data.ownerId) ? (data.ownerId as any) : undefined,
        apiKey: isValidObjectId(data.apiKeyId) ? (data.apiKeyId as any) : undefined,
        bucket: isValidObjectId(data.bucketId) ? (data.bucketId as any) : undefined,
        fileName: data.fileName,
        fileSizeGb: data.fileSizeGb,
        amountPaidUsd: data.amountPaidUsd,
        currency: data.currency,
        txId: data.txId,
        uploaderAddress: data.uploaderAddress,
        network: data.network || 'mainnet',
        durationMonths: data.durationMonths,
        mintType: data.mintType,
        projectUrl: data.projectUrl,
      });
    } catch (err: any) {
      this.logger.warn(`Failed to record paid upload history record: ${err.message}`);
      return null;
    }
  }

  async getPaidUploadsByWallet(walletAddress: string, network?: string, skip: number = 0, limit: number = 50, withTotal: boolean = false) {
    if (!walletAddress) {
      return this.getLatestPaidUploads(network, limit, skip, withTotal);
    }
    const cleanSearch = walletAddress.trim();
    const escapedWallet = cleanSearch.replace(
      /[-[\]{}()*+?.,\\^$|#\s]/g,
      '\\$&',
    );
    const conditions: any[] = [
      { uploaderAddress: { $regex: new RegExp(`^${escapedWallet}$`, 'i') } },
      { txId: { $regex: new RegExp(`^${escapedWallet}$`, 'i') } },
    ];
    if (isValidObjectId(cleanSearch)) {
      conditions.push({ _id: cleanSearch });
    }
    const query: any = { $or: conditions };
    if (network) {
      query.network = network.toLowerCase();
    }
    const totalCountPromise = withTotal ? this.paidUploadModel.countDocuments(query).exec() : Promise.resolve(null);
    const itemsPromise = this.paidUploadModel
      .find(query)
      .populate('bucket')
      .populate('apiKey')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .exec();

    const [total, items] = await Promise.all([totalCountPromise, itemsPromise]);
    if (withTotal) {
      return { items, total: total || 0 };
    }
    return items;
  }

  async getLatestPaidUploads(network?: string, limit: number = 50, skip: number = 0, withTotal: boolean = false) {
    const query: any = {};
    if (network) {
      query.network = network.toLowerCase();
    }
    const totalCountPromise = withTotal ? this.paidUploadModel.countDocuments(query).exec() : Promise.resolve(null);
    const itemsPromise = this.paidUploadModel
      .find(query)
      .populate('bucket')
      .populate('apiKey')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .exec();

    const [total, items] = await Promise.all([totalCountPromise, itemsPromise]);
    if (withTotal) {
      return { items, total: total || 0 };
    }
    return items;
  }

  async verifyWalletProofAndRenew(
    walletAddress: string,
    proofTxn: string,
    x402Payload: any,
    bucketName: string,
    durationMonths: number,
    currency: string = 'USDC',
  ): Promise<Purchase> {
    this.logToFile(
      `[START RENEW BY WALLET] Bucket: ${bucketName}, Wallet: ${walletAddress}, Duration: ${durationMonths}m`,
    );

    if (
      !walletAddress ||
      !proofTxn ||
      !x402Payload ||
      !bucketName ||
      !durationMonths
    ) {
      throw new BadRequestException(
        'walletAddress, proofTxn, x402Payload, bucketName, and durationMonths are required',
      );
    }

    // 1. Fetch and verify bucket
    const bucket = await this.bucketModel
      .findOne({ name: bucketName.toLowerCase().trim() })
      .exec();
    if (!bucket) {
      throw new BadRequestException(`Bucket '${bucketName}' not found.`);
    }

    const owner = await this.userModel.findById(bucket.owner).exec();
    if (!owner) {
      throw new BadRequestException('Bucket owner not found.');
    }

    if (
      !owner.peraWalletAddress ||
      owner.peraWalletAddress.toLowerCase() !== walletAddress.toLowerCase()
    ) {
      throw new BadRequestException(
        'Bucket owner does not match the provided wallet address.',
      );
    }

    // 2. Decode proof transaction
    let txnBytes: Uint8Array;
    let decoded: any;
    try {
      txnBytes = new Uint8Array(Buffer.from(proofTxn, 'base64'));
      decoded = algosdk.decodeSignedTransaction(txnBytes);
    } catch (err: any) {
      throw new BadRequestException(
        `Failed to decode proof transaction: ${err.message}`,
      );
    }

    const txn = decoded.txn;
    if (!txn) {
      throw new BadRequestException('Invalid proof transaction structure.');
    }

    const getAddressStr = (addrObj: any): string => {
      if (!addrObj) return '';
      if (typeof addrObj.toString === 'function') {
        const str = addrObj.toString();
        if (str && str !== '[object Object]') return str;
      }
      if (addrObj.publicKey) {
        return algosdk.encodeAddress(addrObj.publicKey);
      }
      return algosdk.encodeAddress(addrObj);
    };

    const senderStr = getAddressStr(txn.from || txn.sender);
    const receiverStr = getAddressStr(txn.to);

    if (senderStr.toLowerCase() !== walletAddress.toLowerCase()) {
      throw new BadRequestException(
        `Proof transaction sender (${senderStr}) does not match the requested wallet (${walletAddress}).`,
      );
    }

    if (receiverStr.toLowerCase() !== walletAddress.toLowerCase()) {
      throw new BadRequestException(
        'Proof transaction receiver must be the sender itself.',
      );
    }

    const txnType =
      txn.type || txn['tx-type'] || (txn.getType ? txn.getType() : '');
    if (txnType !== 'pay') {
      throw new BadRequestException(
        `Proof transaction type must be payment ('pay'). Got: ${txnType}`,
      );
    }

    const amount = txn.amount !== undefined ? txn.amount : txn.amt;
    if (Number(amount) !== 0) {
      throw new BadRequestException('Proof transaction amount must be 0 ALGO.');
    }

    if (!txn.note) {
      throw new BadRequestException(
        'Proof transaction must contain a note for verification.',
      );
    }

    const noteString = Buffer.from(txn.note).toString();
    const match = noteString.match(
      /^AlgoFile Wallet Proof:\s*([A-Z0-9]+)\s*:\s*(\d+)$/i,
    );
    if (!match) {
      throw new BadRequestException(
        'Invalid note format in proof transaction. Expected: "AlgoFile Wallet Proof: <walletAddress>:<timestamp>"',
      );
    }

    const [_, noteWallet, noteTimestampStr] = match;
    if (noteWallet.toLowerCase() !== walletAddress.toLowerCase()) {
      throw new BadRequestException(
        'Wallet address in proof transaction note does not match sender.',
      );
    }

    const noteTimestamp = parseInt(noteTimestampStr, 10);
    const now = Date.now();
    if (Math.abs(now - noteTimestamp) > 10 * 60 * 1000) {
      throw new BadRequestException(
        'Proof transaction timestamp has expired (valid window: 10 minutes).',
      );
    }

    // 3. Simulate proof transaction using the Mainnet Algod client
    const algodUrl = 'https://mainnet-api.4160.nodely.dev';
    const algodClient = new algosdk.Algodv2('', algodUrl, '');

    try {
      this.logToFile(
        `[INFO] Simulating proof transaction on-chain for wallet: ${walletAddress}`,
      );
      const simulateResult = await algodClient
        .simulateRawTransactions([txnBytes])
        .do();

      const groupResult = simulateResult.txnGroups?.[0];
      if (groupResult?.failureMessage) {
        throw new Error(groupResult.failureMessage);
      }
      this.logToFile(
        `[INFO] Proof transaction successfully verified via node simulation!`,
      );
    } catch (err: any) {
      this.logToFile(
        `[ERROR] Proof transaction simulation failed: ${err.message}`,
      );
      throw new BadRequestException(
        `Proof transaction signature verification failed: ${err.message}`,
      );
    }

    // 4. Map size and execute payment verification
    const planType =
      bucket.maxSizeGb === 10
        ? '10gb'
        : bucket.maxSizeGb === 25
          ? '25gb'
          : bucket.maxSizeGb === 50
            ? '50gb'
            : bucket.maxSizeGb === 0.05
              ? '50mb'
              : 'custom';

    this.logToFile(
      `[INFO] Bucket size is ${bucket.maxSizeGb} GB, mapped to plan: ${planType}. Proceeding to payment verification.`,
    );

    return this.verifyX402Purchase(
      owner._id.toString(),
      x402Payload,
      planType,
      durationMonths,
      currency,
      undefined, // customPriceUsd
      planType === 'custom' ? bucket.maxSizeGb : undefined, // customGb
      bucketName,
    );
  }

  async getLatestPurchases(network?: string, limit: number = 50, skip: number = 0, withTotal: boolean = false) {
    const query: any = {};
    if (network) {
      if (network.toLowerCase() === 'mainnet') {
        query.$or = [
          { network: 'mainnet' },
          { network: { $exists: false } },
          { network: null },
        ];
      } else {
        query.network = 'testnet';
      }
    }
    const totalCountPromise = withTotal ? this.purchaseModel.countDocuments(query).exec() : Promise.resolve(null);
    const itemsPromise = this.purchaseModel
      .find(query)
      .populate('user')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .exec();

    const [total, items] = await Promise.all([totalCountPromise, itemsPromise]);
    const sanitizedItems = items.map((item: any) => {
      const doc = item.toObject ? item.toObject() : { ...item };
      if (
        (doc.senderAddress === this.receiverWallet || !doc.senderAddress) &&
        doc.user &&
        doc.user.peraWalletAddress &&
        doc.user.peraWalletAddress !== this.receiverWallet
      ) {
        doc.senderAddress = doc.user.peraWalletAddress;
      }
      return doc;
    });

    if (withTotal) {
      return { items: sanitizedItems, total: total || 0 };
    }
    return sanitizedItems;
  }

  async getPurchasesByWallet(walletAddress: string, network?: string, skip: number = 0, limit: number = 50, withTotal: boolean = false) {
    if (!walletAddress) {
      return this.getLatestPurchases(network, limit, skip, withTotal);
    }
    const cleanSearch = walletAddress.trim();
    const escapedWallet = cleanSearch.replace(
      /[-[\]{}()*+?.,\\^$|#\s]/g,
      '\\$&',
    );

    const conditions: any[] = [
      { senderAddress: { $regex: new RegExp(`^${escapedWallet}$`, 'i') } },
      { txId: { $regex: new RegExp(`^${escapedWallet}$`, 'i') } },
    ];

    if (isValidObjectId(cleanSearch)) {
      conditions.push({ _id: cleanSearch });
      conditions.push({ user: cleanSearch });
    }

    const matchingUsers = await this.userModel
      .find({
        $or: [
          { email: { $regex: new RegExp(`^${escapedWallet}$`, 'i') } },
          { googleId: cleanSearch },
          { peraWalletAddress: { $regex: new RegExp(`^${escapedWallet}$`, 'i') } },
        ],
      })
      .select('_id')
      .exec();

    if (matchingUsers.length > 0) {
      conditions.push({ user: { $in: matchingUsers.map((u) => u._id) } });
    }

    const query: any = { $or: conditions };
    if (network) {
      if (network.toLowerCase() === 'mainnet') {
        query.$and = [
          {
            $or: [
              { network: 'mainnet' },
              { network: { $exists: false } },
              { network: null },
            ],
          },
        ];
      } else {
        query.network = 'testnet';
      }
    }
    const totalCountPromise = withTotal ? this.purchaseModel.countDocuments(query).exec() : Promise.resolve(null);
    const itemsPromise = this.purchaseModel
      .find(query)
      .populate('user')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .exec();

    const [total, items] = await Promise.all([totalCountPromise, itemsPromise]);
    const sanitizedItems = items.map((item: any) => {
      const doc = item.toObject ? item.toObject() : { ...item };
      if (
        (doc.senderAddress === this.receiverWallet || !doc.senderAddress) &&
        doc.user &&
        doc.user.peraWalletAddress &&
        doc.user.peraWalletAddress !== this.receiverWallet
      ) {
        doc.senderAddress = doc.user.peraWalletAddress;
      }
      return doc;
    });

    if (withTotal) {
      return { items: sanitizedItems, total: total || 0 };
    }
    return sanitizedItems;
  }

  async getApiKeyUsageStats(userId: string) {
    const user = await this.userModel.findById(userId).exec();
    if (!user || user.role !== 'admin') {
      throw new BadRequestException('Acesso negado: Apenas administradores.');
    }

    const uploads = await this.paidUploadModel
      .find()
      .populate('apiKey')
      .populate('owner')
      .exec();

    // Stats holders
    const publicStats = {
      totalUploads: 0,
      totalVolumeGb: 0,
      totalRevenueUsd: 0,
      byProjectUrl: {} as Record<
        string,
        {
          projectUrl: string;
          count: number;
          volumeGb: number;
          revenueUsd: number;
        }
      >,
      byUploaderAddress: {} as Record<
        string,
        {
          uploaderAddress: string;
          count: number;
          volumeGb: number;
          revenueUsd: number;
        }
      >,
      byKeyName: {} as Record<
        string,
        { keyName: string; count: number; volumeGb: number; revenueUsd: number }
      >,
    };

    const customStats = {
      totalUploads: 0,
      totalVolumeGb: 0,
      totalRevenueUsd: 0,
      byProjectUrl: {} as Record<
        string,
        {
          projectUrl: string;
          count: number;
          volumeGb: number;
          revenueUsd: number;
        }
      >,
      byUploaderAddress: {} as Record<
        string,
        {
          uploaderAddress: string;
          count: number;
          volumeGb: number;
          revenueUsd: number;
        }
      >,
      byApiKey: {} as Record<
        string,
        {
          apiKeyId: string;
          name: string;
          prefix: string;
          ownerEmail: string;
          count: number;
          volumeGb: number;
          revenueUsd: number;
        }
      >,
    };

    const officialNames = [
      'algofilerouteapi',
      'algofilerouteapi6m',
      'algofilerouteapi1y',
      'algofilerouteapi2y',
    ];

    for (const upload of uploads) {
      const apiKeyName = upload.apiKey?.name || '';
      const isPublic =
        officialNames.includes(apiKeyName.toLowerCase()) ||
        (upload.apiKey === null && upload.fileName && !upload.owner);

      const projectUrl = upload.projectUrl || 'Direct API Call (No Origin)';
      const uploader = upload.uploaderAddress || 'unknown';
      const volume = upload.fileSizeGb || 0;
      const revenue = upload.amountPaidUsd || 0;

      if (isPublic) {
        publicStats.totalUploads++;
        publicStats.totalVolumeGb += volume;
        publicStats.totalRevenueUsd += revenue;

        // Project URL grouping
        if (!publicStats.byProjectUrl[projectUrl]) {
          publicStats.byProjectUrl[projectUrl] = {
            projectUrl,
            count: 0,
            volumeGb: 0,
            revenueUsd: 0,
          };
        }
        publicStats.byProjectUrl[projectUrl].count++;
        publicStats.byProjectUrl[projectUrl].volumeGb += volume;
        publicStats.byProjectUrl[projectUrl].revenueUsd += revenue;

        // Uploader Wallet grouping
        if (!publicStats.byUploaderAddress[uploader]) {
          publicStats.byUploaderAddress[uploader] = {
            uploaderAddress: uploader,
            count: 0,
            volumeGb: 0,
            revenueUsd: 0,
          };
        }
        publicStats.byUploaderAddress[uploader].count++;
        publicStats.byUploaderAddress[uploader].volumeGb += volume;
        publicStats.byUploaderAddress[uploader].revenueUsd += revenue;

        // Key Name grouping
        const keyLabel = upload.apiKey?.name || 'algofilerouteapi';
        if (!publicStats.byKeyName[keyLabel]) {
          publicStats.byKeyName[keyLabel] = {
            keyName: keyLabel,
            count: 0,
            volumeGb: 0,
            revenueUsd: 0,
          };
        }
        publicStats.byKeyName[keyLabel].count++;
        publicStats.byKeyName[keyLabel].volumeGb += volume;
        publicStats.byKeyName[keyLabel].revenueUsd += revenue;
      } else {
        customStats.totalUploads++;
        customStats.totalVolumeGb += volume;
        customStats.totalRevenueUsd += revenue;

        // Project URL grouping
        if (!customStats.byProjectUrl[projectUrl]) {
          customStats.byProjectUrl[projectUrl] = {
            projectUrl,
            count: 0,
            volumeGb: 0,
            revenueUsd: 0,
          };
        }
        customStats.byProjectUrl[projectUrl].count++;
        customStats.byProjectUrl[projectUrl].volumeGb += volume;
        customStats.byProjectUrl[projectUrl].revenueUsd += revenue;

        // Uploader Wallet grouping
        if (!customStats.byUploaderAddress[uploader]) {
          customStats.byUploaderAddress[uploader] = {
            uploaderAddress: uploader,
            count: 0,
            volumeGb: 0,
            revenueUsd: 0,
          };
        }
        customStats.byUploaderAddress[uploader].count++;
        customStats.byUploaderAddress[uploader].volumeGb += volume;
        customStats.byUploaderAddress[uploader].revenueUsd += revenue;

        // API Key grouping
        const apiKeyId = (upload.apiKey as any)?._id?.toString() || 'unknown';
        const apiKeyLabel = upload.apiKey?.name || 'Deleted Key';
        const apiKeyPrefix = upload.apiKey?.prefix || 'unknown';
        const ownerEmail = upload.owner?.email || 'Unknown User';

        if (!customStats.byApiKey[apiKeyId]) {
          customStats.byApiKey[apiKeyId] = {
            apiKeyId,
            name: apiKeyLabel,
            prefix: apiKeyPrefix,
            ownerEmail,
            count: 0,
            volumeGb: 0,
            revenueUsd: 0,
          };
        }
        customStats.byApiKey[apiKeyId].count++;
        customStats.byApiKey[apiKeyId].volumeGb += volume;
        customStats.byApiKey[apiKeyId].revenueUsd += revenue;
      }
    }

    return {
      publicKeysUsage: {
        totalUploads: publicStats.totalUploads,
        totalVolumeGb: publicStats.totalVolumeGb,
        totalRevenueUsd: publicStats.totalRevenueUsd,
        byProjectUrl: Object.values(publicStats.byProjectUrl).sort(
          (a, b) => b.count - a.count,
        ),
        byUploaderAddress: Object.values(publicStats.byUploaderAddress).sort(
          (a, b) => b.count - a.count,
        ),
        byKeyName: Object.values(publicStats.byKeyName).sort(
          (a, b) => b.count - a.count,
        ),
      },
      customKeysUsage: {
        totalUploads: customStats.totalUploads,
        totalVolumeGb: customStats.totalVolumeGb,
        totalRevenueUsd: customStats.totalRevenueUsd,
        byProjectUrl: Object.values(customStats.byProjectUrl).sort(
          (a, b) => b.count - a.count,
        ),
        byUploaderAddress: Object.values(customStats.byUploaderAddress).sort(
          (a, b) => b.count - a.count,
        ),
        byApiKey: Object.values(customStats.byApiKey).sort(
          (a, b) => b.count - a.count,
        ),
      },
    };
  }

  /**
   * Log an API Key access with origin/referer telemetry
   */
  async logApiKeyAccess(data: {
    apiKeyId?: string;
    apiKeyName: string;
    isPublic: boolean;
    origin?: string;
    referer?: string;
    endpoint: string;
    method: string;
    ip?: string;
    userAgent?: string;
    ownerId?: string;
  }): Promise<void> {
    try {
      const rawOrigin = data.origin || data.referer || '';
      let projectUrl = 'Direct API Call (No Origin)';

      if (rawOrigin) {
        try {
          const parsed = new URL(rawOrigin);
          projectUrl = parsed.origin;
        } catch {
          projectUrl = rawOrigin;
        }
      }

      await this.apiKeyLogModel.create({
        apiKey: data.apiKeyId || null,
        apiKeyName: data.apiKeyName || 'Unknown Key',
        isPublic: data.isPublic ?? false,
        origin: data.origin || '',
        referer: data.referer || '',
        projectUrl,
        endpoint: data.endpoint || '/',
        method: data.method || 'GET',
        ip: data.ip || '',
        userAgent: data.userAgent || '',
        owner: data.ownerId || null,
      });
    } catch (err) {
      this.logger.warn(`Failed to save API key access log: ${err.message}`);
    }
  }

  /**
   * Fetch paginated API key origin logs and summary for Admin panel
   */
  async getApiKeyOriginLogs(params: {
    page?: number;
    limit?: number;
    isPublic?: boolean;
    searchUrl?: string;
  }) {
    const page = Math.max(1, Number(params.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(params.limit) || 20));
    const skip = (page - 1) * limit;

    const filter: any = {};
    if (params.isPublic !== undefined && params.isPublic !== null) {
      filter.isPublic = params.isPublic;
    }
    if (params.searchUrl) {
      filter.$or = [
        { projectUrl: { $regex: params.searchUrl, $options: 'i' } },
        { origin: { $regex: params.searchUrl, $options: 'i' } },
        { referer: { $regex: params.searchUrl, $options: 'i' } },
        { apiKeyName: { $regex: params.searchUrl, $options: 'i' } },
        { ip: { $regex: params.searchUrl, $options: 'i' } },
      ];
    }

    const [logs, total] = await Promise.all([
      this.apiKeyLogModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      this.apiKeyLogModel.countDocuments(filter).exec(),
    ]);

    const originSummary = await this.apiKeyLogModel.aggregate([
      { $match: filter },
      {
        $group: {
          _id: '$projectUrl',
          totalCalls: { $sum: 1 },
          publicCalls: {
            $sum: { $cond: [{ $eq: ['$isPublic', true] }, 1, 0] },
          },
          customCalls: {
            $sum: { $cond: [{ $eq: ['$isPublic', false] }, 1, 0] },
          },
          lastSeen: { $max: '$createdAt' },
        },
      },
      { $sort: { totalCalls: -1 } },
      { $limit: 50 },
    ]);

    return {
      logs,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      originSummary: originSummary.map((item) => ({
        projectUrl: item._id,
        totalCalls: item.totalCalls,
        publicCalls: item.publicCalls,
        customCalls: item.customCalls,
        lastSeen: item.lastSeen,
      })),
    };
  }
}
