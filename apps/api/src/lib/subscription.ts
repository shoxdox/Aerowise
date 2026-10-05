import { DEFAULT_SUBSCRIPTION_CONFIG, type SubscriptionConfig } from "@aerowise/domain";

const KEYS: Record<keyof SubscriptionConfig, string> = {
  trialDays: "AEROWISE_TRIAL_DAYS",
  designPartnerDays: "AEROWISE_DESIGN_PARTNER_DAYS",
  pricePerContractCents: "AEROWISE_PRICE_PER_CONTRACT_CENTS",
  monthlyMinimumCents: "AEROWISE_MONTHLY_MINIMUM_CENTS",
};

/** Aerowise's own prices and free-period lengths. Unset values use the brief's starting assumptions. */
export function subscriptionConfigFromEnv(env: NodeJS.ProcessEnv): SubscriptionConfig {
  const config = { ...DEFAULT_SUBSCRIPTION_CONFIG };
  for (const [field, key] of Object.entries(KEYS) as [keyof SubscriptionConfig, string][]) {
    const raw = env[key]?.trim();
    if (!raw) continue;
    if (!/^\d+$/.test(raw)) throw new Error(`${key} must be a whole number, got "${raw}"`);
    config[field] = Number(raw);
  }
  return config;
}
