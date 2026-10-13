import { declareDiscoveryExtension, declareMerchantExtension } from './x402.types';

/**
 * Centralized Single Source of Truth for all AlgoFile Project Metadata.
 * Any update to project name, description, provider, icons, website, category, tags, or endpoint metadata
 * should be made here.
 */
export const PROJECT_METADATA = {
  name: 'AlgoFile Storage',
  title: 'AlgoFile Storage',
  serviceName: 'AlgoFile Storage',
  description: 'AlgoFile Integrated IPFS Storage Network & x402 Micro-payment Protocol',
  provider: 'AlgoFile Storage',
  iconUrl: 'https://algofile.io/logo_mini.png',
  website: 'https://algofile.io',
  apiUrl: 'https://api.algofile.io',
  category: 'decentralized-storage',
  tag: 'x402-global-challenge',
  tags: [],
  endpoints: {
    storageInfo: {
      url: 'https://api.algofile.io/api/v3/x402/bazaar/storage-info',
      name: 'AlgoFile Storage',
      description: 'AlgoFile Integrated IPFS Storage Network & x402 Micro-payment Protocol',
    },
    assetInfo: {
      url: 'https://api.algofile.io/api/v3/x402/bazaar/asset-storage-info',
      name: 'AlgoFile Storage',
      description: 'AlgoFile Integrated IPFS Storage Network & x402 Micro-payment Protocol',
    },
    bucketProvision: {
      url: 'https://api.algofile.io/api/v3/collections/provision-bundle-bucket-x402',
      name: 'AlgoFile Storage',
      description: 'AlgoFile Integrated IPFS Storage Network & x402 Micro-payment Protocol',
    },

    verifyPurchase: {
      url: 'https://api.algofile.io/api/v3/purchases/x402-verify',
      name: 'AlgoFile Storage',
      description: 'AlgoFile Integrated IPFS Storage Network & x402 Micro-payment Protocol',
    },
  },
} as const;

export interface ProjectMetadataOptions {
  projectName?: string;
  projectDescription?: string;
  projectIcon?: string;
  planType?: string;
  capacityGb?: number;
  durationMonths?: number;
  itemCount?: number;
  fileName?: string;
  defaultName?: string;
  defaultDescription?: string;
  defaultIcon?: string;
  tag?: string;
  tags?: string[];
  categories?: string[];
  x402PayloadResource?: any;
}

export interface ResolvedProjectMetadata {
  name: string;
  description: string;
  iconUrl: string;
  tag: string;
  tags: string[];
  category: string;
  provider: string;
}

/**
 * Standardized class responsible for resolving, formatting, and building
 * project metadata (name, description, iconUrl, tag) across all x402 routes and Facilitator integrations.
 */
export class ProjectMetadataResolver {
  public static readonly DEFAULT_NAME = PROJECT_METADATA.name;
  public static readonly DEFAULT_DESCRIPTION = PROJECT_METADATA.description;
  public static readonly DEFAULT_ICON = PROJECT_METADATA.iconUrl;
  public static readonly DEFAULT_PROVIDER = PROJECT_METADATA.provider;
  public static readonly DEFAULT_CATEGORY = PROJECT_METADATA.category;
  public static readonly DEFAULT_TAG = PROJECT_METADATA.tag;
  public static readonly DEFAULT_WEBSITE = PROJECT_METADATA.website;
  public static readonly DEFAULT_API_URL = PROJECT_METADATA.apiUrl;

  /**
   * Returns standardized agent card / project metadata object for public discovery endpoints.
   */
  public static getAgentCard() {
    return {
      name: PROJECT_METADATA.title,
      title: PROJECT_METADATA.title,
      serviceName: PROJECT_METADATA.serviceName,
      description: PROJECT_METADATA.description,
      url: PROJECT_METADATA.website,
      apiUrl: PROJECT_METADATA.apiUrl,
      iconUrl: PROJECT_METADATA.iconUrl,
      icon: PROJECT_METADATA.iconUrl,
      category: PROJECT_METADATA.category,
      provider: PROJECT_METADATA.provider,
      tag: PROJECT_METADATA.tag,
      tags: [...PROJECT_METADATA.tags],
      endpoints: {
        storageInfo: PROJECT_METADATA.endpoints.storageInfo.url,
        assetInfo: PROJECT_METADATA.endpoints.assetInfo.url,
        verifyPurchase: PROJECT_METADATA.endpoints.verifyPurchase.url,
        provisionBucket: PROJECT_METADATA.endpoints.bucketProvision.url,
      },
    };
  }

  /**
   * Resolves standardized project metadata (Name, Description, Icon, Tag).
   * Always enforces AlgoFile brand metadata so the Facilitator dashboard displays AlgoFile!
   */
  public static resolve(options: ProjectMetadataOptions = {}): ResolvedProjectMetadata {
    const name = this.DEFAULT_NAME;
    const description = this.DEFAULT_DESCRIPTION;
    const iconUrl = this.DEFAULT_ICON;

    return {
      name,
      description,
      iconUrl,
      tag: options.tag || this.DEFAULT_TAG,
      tags: options.tags || [...PROJECT_METADATA.tags],
      category: this.DEFAULT_CATEGORY,
      provider: name,
    };
  }

  /**
   * Builds a standard x402 Merchant Extension carrying info and draft 2020-12 schema using resolved metadata.
   * Defaulting categories to empty array ensures the Facilitator displays the domain (algofile.io) instead of a category tag.
   */
  public static buildMerchantExtension(options: ProjectMetadataOptions = {}) {
    const meta = this.resolve(options);
    return declareMerchantExtension({
      name: meta.name,
      website: PROJECT_METADATA.website,
      logo: meta.iconUrl,
      categories: options.categories ?? [],
    });
  }

  /**
   * Builds a standard x402 Bazaar Extension using the resolved metadata.
   */
  public static buildBazaarExtension(
    options: ProjectMetadataOptions & {
      /** HTTP verb of the paid endpoint — the catalog records it, so GET on a POST route is wrong. */
      method?: 'GET' | 'HEAD' | 'DELETE' | 'POST' | 'PUT' | 'PATCH';
      bodyType?: 'json' | 'form-data' | 'text';
      /** Example request and response. The Bazaar SDK wants samples, not JSON Schema. */
      input?: Record<string, any>;
      output?: Record<string, any>;
    },
  ) {
    const meta = this.resolve(options);

    return declareDiscoveryExtension({
      method: options.method,
      bodyType: options.bodyType,
      title: meta.name,
      description: meta.description,
      category: meta.category,
      provider: meta.name,
      iconUrl: meta.iconUrl,
      tag: meta.tag,
      tags: options.tags || meta.tags,
      input: options.input || {},
      output: options.output,
    });
  }

  /**
   * Helper to build a standard Bazaar Extension directly for a registered endpoint key from PROJECT_METADATA.
   */
  public static buildBazaarExtensionFor(
    endpointKey: keyof typeof PROJECT_METADATA.endpoints,
    options: {
      method?: 'GET' | 'HEAD' | 'DELETE' | 'POST' | 'PUT' | 'PATCH';
      bodyType?: 'json' | 'form-data' | 'text';
      input?: Record<string, any>;
      output?: Record<string, any>;
    } = {},
  ) {
    const endpoint = PROJECT_METADATA.endpoints[endpointKey];
    return this.buildBazaarExtension({
      projectName: endpoint?.name || PROJECT_METADATA.name,
      projectDescription: endpoint?.description || PROJECT_METADATA.description,
      method: options.method,
      bodyType: options.bodyType,
      input: options.input,
      output: options.output,
    });
  }
}
