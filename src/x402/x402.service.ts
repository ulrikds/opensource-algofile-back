import { Injectable, BadRequestException, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import * as algosdk from 'algosdk';
import {
  X402PaymentPayload,
  X402PaymentRequirements,
  BazaarExtension,
  X402HeaderPayload,
  DiscoveryOptions,
  declareDiscoveryExtension,
  sanitizeResourceServiceMetadata,
  CHALLENGE_TAG,
} from './x402.types';
import { ProjectMetadataResolver } from './project-metadata.resolver';

export * from './x402.types';
export * from './project-metadata.resolver';

@Injectable()
export class X402Service implements OnModuleInit {
  private readonly logger = new Logger(X402Service.name);
  private readonly facilitatorUrl: string;
  private facilitatorFeePayer: string =
    'ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA';

  /**
   * Helper to parse x402 payment payload from request headers or body
   */
  extractX402Payload(req: any, body?: any): X402PaymentPayload | null {
    const raw =
      req.headers?.['payment-signature'] ||
      req.headers?.['Payment-Signature'] ||
      req.headers?.['x-x402-payment-payload'] ||
      req.headers?.['x-payment-payload'] ||
      req.query?.x402Payload ||
      req.query?.paymentPayload ||
      body?.x402Payload ||
      req.body?.x402Payload;
    if (!raw) return null;
    if (typeof raw !== 'string') return raw;
    try {
      const jsonStr = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString();
      return JSON.parse(jsonStr);
    } catch {
      throw new BadRequestException('Invalid JSON or Base64 format in x402Payload');
    }
  }

  /**
   * Helper to decode an x402 payment payload transaction group and extract the sender wallet address.
   */
  extractSenderFromPayload(x402Payload: any): string | null {
    if (!x402Payload) return null;
    try {
      let rawTxnBase64: string | undefined;
      const paymentIndex = x402Payload?.payload?.paymentIndex ?? 0;
      if (
        x402Payload?.payload?.paymentGroup &&
        Array.isArray(x402Payload.payload.paymentGroup) &&
        x402Payload.payload.paymentGroup.length > paymentIndex
      ) {
        rawTxnBase64 = x402Payload.payload.paymentGroup[paymentIndex];
      } else if (x402Payload?.signedTxn) {
        rawTxnBase64 = x402Payload.signedTxn;
      }

      if (!rawTxnBase64) return null;

      const txnBytes = Buffer.from(rawTxnBase64, 'base64');
      const decoded = algosdk.decodeSignedTransaction(txnBytes);
      const txnAny = decoded.txn as any;
      if (txnAny.from) {
        return typeof txnAny.from.toString === 'function'
          ? txnAny.from.toString()
          : algosdk.encodeAddress(txnAny.from.publicKey || txnAny.from);
      } else if (txnAny.sender) {
        return typeof txnAny.sender.toString === 'function'
          ? txnAny.sender.toString()
          : algosdk.encodeAddress(txnAny.sender.publicKey || txnAny.sender);
      }
    } catch (err: any) {
      this.logger.debug(`Failed to extract sender address from x402 payload: ${err.message}`);
    }
    return null;
  }

  /**
   * Resolves a price string (e.g. "$0.01") or spec object into exact ASA ID and base unit amount.
   * Per Algorand x402 exact scheme spec:
   * Testnet USDC = ASA 10458941, Mainnet USDC = ASA 31566704.
   * $0.01 with 6 decimals = 10,000 base units.
   */
  resolvePrice(
    price?: any,
    networkStr?: string,
  ): { asset: string; amount: string; extra: Record<string, any> } {
    const network = this.getCaip2Network(networkStr);
    const isTestnet = network.includes('SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9');
    const defaultUsdcAsset = isTestnet ? '10458941' : '31566704';

    if (typeof price === 'object' && price !== null) {
      return {
        asset: price.asset || defaultUsdcAsset,
        amount: price.amount || '10000',
        extra: {
          name: 'USDC',
          decimals: 6,
          ...(price.extra || {}),
        },
      };
    }

    if (typeof price === 'string' && price.startsWith('$')) {
      const numericVal = parseFloat(price.replace('$', ''));
      if (!isNaN(numericVal)) {
        const baseUnits = Math.round(numericVal * 1000000).toString();
        return {
          asset: defaultUsdcAsset,
          amount: baseUnits,
          extra: {
            name: 'USDC',
            decimals: 6,
          },
        };
      }
    }

    return {
      asset: defaultUsdcAsset,
      amount: '10000',
      extra: { name: 'USDC', decimals: 6 },
    };
  }

  /**
   * Constructs standardized X402PaymentRequirements object with defaults and campaign challenge tag.
   */
  createRequirements(options: {
    url?: string;
    amount?: string;
    asset?: string;
    price?: any;
    payTo?: string;
    network?: string;
    tag?: string;
    extra?: Record<string, any>;
  }): X402PaymentRequirements {
    const receiverWallet =
      options.payTo ||
      this.configService.get<string>('AVM_ADDRESS') ||
      this.configService.get<string>('RECEIVER_WALLET') ||
      this.configService.get<string>('ALGORAND_RECEIVER_WALLET') ||
      'IYYLWNTA7QNG7SJOBKEGSBHQ3KENT6RKOWH4AMIBYR7Y2WF4B4KCIJ6WQQ';

    const network = options.network || this.getCaip2Network();
    const targetUrl = this.toAbsoluteUrl(options.url);
    const tag = options.tag || CHALLENGE_TAG;

    let asset = options.asset;
    let amount = options.amount;
    let extraObj = options.extra || {};

    if (options.price) {
      const resolved = this.resolvePrice(options.price, network);
      asset = asset || resolved.asset;
      amount = amount || resolved.amount;
      extraObj = { ...resolved.extra, ...extraObj };
    }

    const finalAsset = asset || (network.includes('SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9') ? '10458941' : '31566704');
    const finalAmount = amount || '10000';

    return this.withChallengeTag({
      scheme: 'exact',
      network,
      asset: finalAsset,
      amount: finalAmount,
      payTo: receiverWallet,
      maxTimeoutSeconds: 300,
      url: targetUrl,
      tag,
      extra: {
        asset: finalAsset,
        tag,
        ...extraObj,
      },
    });
  }

  constructor(private readonly configService: ConfigService) {
    this.facilitatorUrl =
      this.configService.get<string>('FACILITATOR_URL') ||
      'https://facilitator.goplausible.xyz';
  }

  async onModuleInit() {
    try {
      const res = await fetch(`${this.facilitatorUrl}/supported`);
      if (res.ok) {
        const data = await res.json();
        const algoSigner = data?.signers?.['algorand:*']?.[0];
        if (algoSigner) {
          this.facilitatorFeePayer = algoSigner;
          this.logger.log(`Fetched Facilitator Gasless FeePayer: ${this.facilitatorFeePayer}`);
        }
      }
    } catch (err: any) {
      this.logger.debug(`Could not fetch feePayer from ${this.facilitatorUrl}/supported: ${err.message}`);
    }
  }

  /**
   * Public base URL of this API. The Bazaar catalog keys resources by this URL and
   * the challenge dashboard only counts publicly reachable HTTPS endpoints, so a
   * localhost value here means the resource never shows up on the leaderboard.
   */
  get backendBaseUrl(): string {
    return (
      this.configService.get<string>('BACKEND_URL') ||
      'https://api.algofile.io'
    ).replace(/\/$/, '');
  }

  /** Resolves a resource path against BACKEND_URL so the Facilitator indexes the live API endpoint. */
  toAbsoluteUrl(url?: string): string {
    if (!url) return `${this.backendBaseUrl}/api/v3/purchases/x402-verify`;
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    const path = url.startsWith('/') ? url : `/${url}`;
    const fullPath = path.startsWith('/api/') ? path : `/api${path}`;
    return `${this.backendBaseUrl}${fullPath}`;
  }

  /**
   * Stamps the campaign tag and gasless feePayer address required by x402 specification.
   */
  private withChallengeTag(
    requirements: X402PaymentRequirements,
  ): X402PaymentRequirements {
    const currentExtra = requirements.extra || {};
    const tag = currentExtra.tag || (requirements as any).tag || CHALLENGE_TAG;
    const asset = currentExtra.asset || requirements.asset || '31566704';
    const feePayer =
      currentExtra.feePayer ||
      this.configService.get<string>('FACILITATOR_FEE_PAYER') ||
      this.configService.get<string>('FEE_PAYER') ||
      this.facilitatorFeePayer;

    const reqCopy: any = { ...requirements };
    delete reqCopy.tag;

    return {
      ...reqCopy,
      extra: {
        ...currentExtra,
        asset,
        feePayer,
        tag,
      },
    };
  }

  /**
   * Returns the CAIP-2 network identifier for Algorand based on environment or network string.
   */
  getCaip2Network(networkStr?: string): string {
    const net = (
      networkStr ||
      this.configService.get<string>('ALGORAND_NETWORK') ||
      'testnet'
    ).toLowerCase();
    if (net === 'mainnet' || net.includes('wghe2')) {
      return 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=';
    }
    return 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=';
  }

  /**
   * Verifies and settles an x402 payment payload via the Algorand Payment Facilitator.
   * When a bazaarExtension is provided, it is included in the payload so the facilitator
   * can catalog the resource in the Bazaar discovery service.
   */
  async verifyAndSettle(
    x402Payload: X402PaymentPayload | any,
    rawRequirements: X402PaymentRequirements,
    bazaarExtension?: BazaarExtension,
  ): Promise<{ success: boolean; txId: string; network: string }> {
    this.logger.log(`Initiating x402 verify & settle flow...`);
    const requirements = this.withChallengeTag(rawRequirements);

    if (
      !x402Payload ||
      !x402Payload.payload ||
      !Array.isArray(x402Payload.payload.paymentGroup)
    ) {
      throw new BadRequestException('Invalid x402 payment payload format.');
    }

    const currentTimestamp = new Date().toISOString();
    // Requirements first: the client's `resource.url` is a relative path from the
    // browser ('/purchases/x402-verify') and misses the global 'api' prefix, so
    // trusting it catalogs a 404 URL. The server's requirement URL is the truth.
    const currentUrl = this.toAbsoluteUrl(
      requirements.url || x402Payload?.resource?.url,
    );

    const resolvedMeta = ProjectMetadataResolver.resolve({
      projectName: bazaarExtension?.info?.title || x402Payload?.resource?.serviceName,
      projectDescription: bazaarExtension?.info?.description || x402Payload?.resource?.description,
      projectIcon: bazaarExtension?.info?.iconUrl || x402Payload?.resource?.iconUrl,
      x402PayloadResource: x402Payload?.resource,
    });

    const effectiveExtension =
      bazaarExtension ||
      ProjectMetadataResolver.buildBazaarExtension({
        projectName: resolvedMeta.name,
        projectDescription: resolvedMeta.description,
        projectIcon: resolvedMeta.iconUrl,
        tag: resolvedMeta.tag,
        x402PayloadResource: x402Payload?.resource,
      });

    const headerPayload = this.buildHeaderPayload(
      { ...requirements, url: currentUrl },
      effectiveExtension,
    );

    const effectiveTag = rawRequirements.extra?.tag || resolvedMeta.tag || CHALLENGE_TAG;
    const resource = {
      url: currentUrl,
      description: resolvedMeta.description,
      mimeType: x402Payload?.resource?.mimeType || 'application/json',
      serviceName: resolvedMeta.name,
      iconUrl: resolvedMeta.iconUrl,
    };

    const meta = {
      timestamp: currentTimestamp,
      url: currentUrl,
      resource,
    };

    const requestBody = {
      x402Version: 2,
      resource,
      accepts: [requirements],
      extra: {
        ...(requirements?.extra || {}),
        tag: effectiveTag,
      },
      ...(headerPayload?.extensions ? { extensions: headerPayload.extensions } : {}),
      paymentPayload: {
        ...x402Payload,
        ...meta,
        accepted: requirements,
        extra: {
          ...(x402Payload?.extra || {}),
          tag: effectiveTag,
        },
        ...(headerPayload?.extensions ? { extensions: headerPayload.extensions } : {}),
      },
      paymentRequirements: {
        ...requirements,
        ...meta,
        accepts: [requirements],
        extra: {
          ...(requirements?.extra || {}),
          tag: effectiveTag,
        },
        ...(headerPayload?.extensions ? { extensions: headerPayload.extensions } : {}),
      },
    };

    // 1. Verify with Facilitator
    try {
      this.logger.log(
        `Calling Facilitator verify: ${this.facilitatorUrl}/verify`,
      );
      const verifyRes = await fetch(`${this.facilitatorUrl}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      if (verifyRes.ok) {
        const verifyData = await verifyRes.json();
        if (verifyData.isValid === false) {
          throw new BadRequestException(
            `x402 Verification Failed: ${verifyData.invalidReason || 'Invalid transaction group'}`,
          );
        }
      } else {
        const errText = await verifyRes.text();
        throw new BadRequestException(
          `x402 Verification Failed (HTTP ${verifyRes.status}): ${errText}`,
        );
      }
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(
        `x402 Verification failed to execute: ${err.message}`,
      );
    }

    // 2. Settle with Facilitator
    try {
      this.logger.log(
        `Calling Facilitator settle: ${this.facilitatorUrl}/settle`,
      );
      const settleRes = await fetch(`${this.facilitatorUrl}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      if (!settleRes.ok) {
        const errText = await settleRes.text();
        throw new BadRequestException(
          `x402 Settlement Failed (HTTP ${settleRes.status}): ${errText}`,
        );
      }

      const settleData = await settleRes.json();
      if (!settleData.success && !settleData.transaction) {
        throw new BadRequestException(
          `x402 Settlement Failed: ${settleData.error || settleData.message || 'Transaction submission rejected'}`,
        );
      }

      const txId = settleData.transaction || settleData.txId;
      this.logger.log(`x402 Settle successful! TxID: ${txId}`);
      return {
        success: true,
        txId,
        network: settleData.network || requirements.network,
      };
    } catch (err: any) {
      this.logger.error(`x402 Settle Exception: ${err.message}`);
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(`x402 Settlement error: ${err.message}`);
    }
  }
  /**
   * Builds the structured x402 v2 payment-required JSON object containing accepts, Bazaar discovery, and optional x402-merchant extensions.
   */
  buildHeaderPayload(
    rawRequirements: X402PaymentRequirements,
    bazaarExtension?: BazaarExtension,
    customExtensions?: Record<string, any>,
  ): X402HeaderPayload {
    const requirements = this.withChallengeTag(rawRequirements);
    const resourceUrl = this.toAbsoluteUrl(requirements.url);

    const reqClean: any = {
      scheme: requirements.scheme || 'exact',
      network: requirements.network || this.getCaip2Network(),
      amount: requirements.amount,
      asset: requirements.asset || '31566704',
      payTo: requirements.payTo,
      maxTimeoutSeconds: requirements.maxTimeoutSeconds || 300,
      extra: {
        ...(requirements.extra || {}),
        asset: requirements.extra?.asset || requirements.asset || '31566704',
        feePayer: requirements.extra?.feePayer || this.facilitatorFeePayer,
        tag: requirements.extra?.tag || CHALLENGE_TAG,
      },
    };

    const resolvedMeta = ProjectMetadataResolver.resolve({
      projectName:
        bazaarExtension?.info?.title ||
        bazaarExtension?.info?.name ||
        bazaarExtension?.info?.serviceName,
      projectDescription: bazaarExtension?.info?.description,
      projectIcon: bazaarExtension?.info?.iconUrl || bazaarExtension?.info?.icon,
      tag: rawRequirements.extra?.tag || bazaarExtension?.info?.tag,
    });

    const payload: X402HeaderPayload = {
      x402Version: 2,
      error: 'Payment required',
      resource: {
        url: resourceUrl,
        description: resolvedMeta.description,
        mimeType: 'application/json',
        serviceName: resolvedMeta.name,
        iconUrl: resolvedMeta.iconUrl,
      },
      accepts: [reqClean],
    };

    const extensionsMap: Record<string, any> = {};

    if (bazaarExtension) {
      const extObj = (bazaarExtension as any).bazaar || bazaarExtension;
      extensionsMap.bazaar = extObj;
    }

    // Always include standard merchant extension so Facilitator registers AlgoFile Storage identity
    const merchantExt =
      (customExtensions as any)?.merchant ||
      (customExtensions as any)?.['x402-merchant'] ||
      ProjectMetadataResolver.buildMerchantExtension();
    const cleanMerchant = (merchantExt as any).merchant || merchantExt;
    extensionsMap.merchant = cleanMerchant;
    extensionsMap['x402-merchant'] = cleanMerchant;

    if (customExtensions) {
      Object.assign(extensionsMap, customExtensions);
    }

    if (Object.keys(extensionsMap).length > 0) {
      payload.extensions = extensionsMap;
    }

    return payload;
  }

  /**
   * Encodes the x402 v2 payment requirements and extensions into a Base64 string for the HTTP payment-required header.
   */
  encodePaymentRequiredHeader(
    requirements: X402PaymentRequirements,
    bazaarExtension?: BazaarExtension,
    customExtensions?: Record<string, any>,
  ): string {
    const payload = this.buildHeaderPayload(requirements, bazaarExtension, customExtensions);
    return Buffer.from(JSON.stringify(payload)).toString('base64');
  }

  /**
   * Helper method to build standard TS discovery extension.
   */
  declareDiscoveryExtension(options: DiscoveryOptions): BazaarExtension {
    return declareDiscoveryExtension(options);
  }

  /**
   * Sends a standard HTTP 402 Payment Required response with the payment-required Base64 header and body containing extensions.
   */
  send402Response(
    res: Response,
    requirements: X402PaymentRequirements,
    bazaarExtension?: BazaarExtension | DiscoveryOptions,
    message: string = 'Payment Required',
    customExtensions?: Record<string, any>,
  ): void {
    // Always produce a bazaar extension — auto-generate default when none provided
    const extension: BazaarExtension = bazaarExtension
      ? (bazaarExtension as BazaarExtension).info
        ? (bazaarExtension as BazaarExtension)
        : declareDiscoveryExtension(bazaarExtension as DiscoveryOptions)
      : declareDiscoveryExtension({
        title: 'AlgoFile Resource',
        description: 'AlgoFile x402 Paid Resource API',
        category: 'decentralized-storage',
        provider: 'AlgoFile Storage',
      });

    const base64Header = this.encodePaymentRequiredHeader(
      requirements,
      extension,
      customExtensions,
    );
    const headerPayload = this.buildHeaderPayload(
      requirements,
      extension,
      customExtensions,
    );

    res.setHeader('payment-required', base64Header);
    res.setHeader('Payment-Required', base64Header);
    res.setHeader('PAYMENT-REQUIRED', base64Header);
    res.setHeader('WWW-Authenticate', `x402 ${base64Header}`);
    res.setHeader('www-authenticate', `x402 ${base64Header}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader(
      'Access-Control-Expose-Headers',
      '*, payment-required, Payment-Required, PAYMENT-REQUIRED, www-authenticate, WWW-Authenticate, payment-response, Payment-Response, PAYMENT-RESPONSE, x-payment-required, X-Payment-Required, x-payment-payload, X-Payment-Payload, x-x402-payment-payload, X-X402-Payment-Payload, payment-signature, Payment-Signature, PAYMENT-SIGNATURE',
    );

    res.status(402).json(headerPayload);
  }
}


