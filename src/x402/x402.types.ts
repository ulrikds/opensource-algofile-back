import type {
  PaymentPayload,
  PaymentRequirements,
  PaymentRequired,
  ResourceInfo,
  Network,
} from '@x402/core/types';

import {
  declareDiscoveryExtension as officialDeclareDiscoveryExtension,
  isValidServiceName,
  sanitizeTags,
  isValidIconUrl,
  sanitizeResourceServiceMetadata,
  type DiscoveryExtension,
} from '@x402/extensions/bazaar';

/**
 * Official x402 Protocol Types directly imported from @x402/core and @x402/extensions.
 */
export type { Network };

export type X402PaymentPayload = PaymentPayload & {
  x402Version?: number;
  scheme?: string;
  network?: string | Network;
  resource?: ResourceInfo | Partial<ResourceInfo>;
  payload?: any;
  accepted?: any;
  [key: string]: any;
};

export type X402PaymentRequirements = Omit<PaymentRequirements, 'network' | 'maxTimeoutSeconds' | 'extra'> & {
  scheme: string;
  network: string | Network;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, any>;
  url?: string;
  [key: string]: any;
};

export type X402ResourceMetadata = Partial<ResourceInfo> & {
  url?: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tag?: string;
  tags?: string[];
  iconUrl?: string;
  [key: string]: any;
};

export type X402HeaderPayload = Omit<PaymentRequired, 'accepts'> & {
  x402Version: number;
  error?: string;
  resource?: X402ResourceMetadata;
  accepts: X402PaymentRequirements[];
  extensions?: Record<string, any>;
};

export type BazaarExtension = DiscoveryExtension | any;
export type DiscoveryOptions = {
  /** HTTP verb of the paid endpoint. Required by the Bazaar spec schema. */
  method?: 'GET' | 'HEAD' | 'DELETE' | 'POST' | 'PUT' | 'PATCH';
  bodyType?: 'json' | 'form-data' | 'text';
  /** Example request: query params for GET-likes, body for POST-likes. */
  input?: Record<string, any>;
  /** Example successful response body. */
  output?: Record<string, any>;
  title?: string;
  description?: string;
  category?: string;
  provider?: string;
  tag?: string;
  [key: string]: any;
};

const BODY_METHODS = ['POST', 'PUT', 'PATCH'];

/** Campaign tag the challenge dashboard filters on (`src=x402-global-challenge`). */
export const CHALLENGE_TAG = 'x402-global-challenge';


/**
 * Bazaar discovery extension.
 */
export function declareDiscoveryExtension(
  options: DiscoveryOptions,
): BazaarExtension {
  const method = options.method || 'GET';
  const customTags = options.tags || (options.tag ? [options.tag] : []);
  const combinedTags = customTags;

  const config: any = { method, input: options.input || {} };
  if (BODY_METHODS.includes(method)) config.bodyType = options.bodyType || 'json';
  if (options.output) config.output = { example: options.output };

  const result: any = officialDeclareDiscoveryExtension(config);
  const ext = result?.bazaar || result;

  if (ext?.schema?.properties?.input?.properties?.method) {
    ext.schema.properties.input.properties.method.enum = [method];
  }

  if (method === 'GET' && ext?.info?.input) {
    ext.info.input.queryParams = options.input?.queryParams || {
      schema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    };
  }

  return {
    info: ext.info,
    schema: ext.schema,
    discoverable: true,
    category: options.category || 'decentralized-storage',
    tags: combinedTags,
  };
}

export type MerchantIdentityInfo = {
  name: string;
  website?: string;
  logo?: string;
  categories?: string[];
  [key: string]: any;
};

export type MerchantIdentityExtension = {
  info: MerchantIdentityInfo;
  schema: {
    $schema: string;
    type: 'object';
    required: string[];
    properties: Record<string, { type: string; items?: { type: string } }>;
  };
};

export type PriceSpec =
  | string
  | {
    asset: string;
    amount: string;
    extra?: {
      name?: string;
      decimals?: number;
      [key: string]: any;
    };
  };

/**
 * Creates standard x402-merchant extension carrying info and draft 2020-12 JSON Schema.
 */
export function declareMerchantExtension(
  info: MerchantIdentityInfo,
): MerchantIdentityExtension {
  return {
    info: {
      name: info.name,
      website: info.website || '',
      logo: info.logo || '',
      categories: info.categories ?? [],
    },
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        website: { type: 'string' },
        logo: { type: 'string' },
        categories: { type: 'array', items: { type: 'string' } },
      },
    },
  };
}

export {
  isValidServiceName,
  sanitizeTags,
  isValidIconUrl,
  sanitizeResourceServiceMetadata,
};

