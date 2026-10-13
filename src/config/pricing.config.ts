/**
 * Centralized Pricing Configuration for AlgoFile Storage Network.
 * Prevents pricing contradictions and hardcoded magic numbers across services and controllers.
 */
export const PRICING_CONFIG = {
  /**
   * Storage Bucket Subscription rate ($ USD per GB per Month)
   */
  BUCKET_STORAGE_RATE_PER_GB_MONTH: 0.20,

  /**
   * Starter 50MB Plan fixed price in USD
   */
  PLAN_50MB_PRICE_USD: 12.00,

  /**
   * Pay-Per-Upload rates ($ USD per GB)
   */
  SINGLE_UPLOAD_RATE_PER_GB: 0.40,
  BULK_UPLOAD_RATE_PER_GB: 0.40, // 0.4 USD per GB for bulk folder uploads

  /**
   * API Key Plan Duration Rates ($ USD per GB)
   */
  API_KEY_RATES: {
    DEFAULT_RATE_PER_GB: 0.20,
    ROUTE_6M_RATE_PER_GB: 0.40,
    ROUTE_1Y_RATE_PER_GB: 0.80,
    ROUTE_2Y_RATE_PER_GB: 1.60,
  },

  /**
   * Bazaar Discovery Metadata Rate ($ USD per GB)
   */
  BAZAAR_STORAGE_INFO_RATE_PER_GB: 0.40,
};
