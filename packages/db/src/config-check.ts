import { parseFeatures } from "@aerowise/domain";

/**
 * The boot-time configuration check shared by the API and the worker. Outside production
 * nothing is required: missing providers fall back to the built-in test ones. In
 * production (NODE_ENV=production) the process refuses to start, naming every problem at
 * once, so a deploy fails loudly instead of running with a hole in it.
 *
 * DEPLOY_ENV says which deployment this is:
 * - "staging": real providers are optional, but real email must be redirected to a test
 *   inbox (EMAIL_REDIRECT_TO), so synthetic filings never reach an authority;
 * - "production": real email (Resend) and file storage (R2) are required, and nothing is redirected.
 */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Refusing to start: the configuration is incomplete.\n${problems.map((p) => `- ${p}`).join("\n")}\nSee .env.example.`);
  }
}

type Env = Record<string, string | undefined>;

const R2_KEYS = ["R2_ACCOUNT_ID", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"];
const MAIL_FROM_KEYS = ["FILING_EMAIL_FROM", "INVOICE_EMAIL_FROM", "ACCOUNT_EMAIL_FROM"];
/** Development defaults that must never reach a deployed server. */
const DEV_SECRETS = new Set(["aerowise-development-only-signing-secret", "aerowise-development-only-quickbooks-key", "change-me", "changeme", "secret"]);

export function configProblems(env: Env): string[] {
  if (env.NODE_ENV !== "production") return [];
  const problems: string[] = [];
  try {
    parseFeatures(env.AEROWISE_FEATURES);
  } catch (err) {
    problems.push((err as Error).message);
  }
  const set = (k: string) => !!env[k]?.trim();
  const missing = (keys: string[], why: string) => {
    const names = keys.filter((k) => !set(k));
    if (names.length) problems.push(`${names.join(", ")} ${names.length === 1 ? "is" : "are"} required ${why}`);
  };
  const deploy = env.DEPLOY_ENV;

  if (deploy !== "staging" && deploy !== "production") problems.push('DEPLOY_ENV must be "staging" or "production" when NODE_ENV=production');
  missing(["DATABASE_URL", "FILE_SIGNING_SECRET", "PUBLIC_APP_URL"], "in production");
  const signing = env.FILE_SIGNING_SECRET?.trim();
  if (signing && (signing.length < 32 || DEV_SECRETS.has(signing))) problems.push("FILE_SIGNING_SECRET must be a long random value (at least 32 characters)");
  if (set("PUBLIC_APP_URL") && !/^https:\/\//.test(env.PUBLIC_APP_URL!)) problems.push("PUBLIC_APP_URL must start with https:// in production");

  // A provider is either fully configured or off; half a configuration is a mistake.
  if (set("QUICKBOOKS_CLIENT_ID") || set("QUICKBOOKS_CLIENT_SECRET")) {
    missing(["QUICKBOOKS_CLIENT_ID", "QUICKBOOKS_CLIENT_SECRET", "QUICKBOOKS_TOKEN_KEY"], "when QuickBooks is configured");
    if (set("QUICKBOOKS_TOKEN_KEY") && DEV_SECRETS.has(env.QUICKBOOKS_TOKEN_KEY!.trim())) problems.push("QUICKBOOKS_TOKEN_KEY must not be the development key");
  }
  if (set("STRIPE_SECRET_KEY")) missing(["STRIPE_WEBHOOK_SECRET"], "when Stripe is configured");
  if (set("STRIPE_BILLING_SECRET_KEY")) missing(["STRIPE_BILLING_WEBHOOK_SECRET"], "when Stripe Billing is configured");
  if (set("TWILIO_ACCOUNT_SID") !== set("TWILIO_AUTH_TOKEN")) missing(["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"], "together");
  if (R2_KEYS.some(set)) missing(R2_KEYS, "together for Cloudflare R2");
  if (set("RESEND_API_KEY")) missing(["RESEND_WEBHOOK_SECRET", ...MAIL_FROM_KEYS], "when Resend is configured");

  if (deploy === "production") {
    missing(["RESEND_API_KEY"], "in production (otherwise email is only written to the outbox)");
    if (!R2_KEYS.some(set)) missing(R2_KEYS, "in production (otherwise files stay on the server's disk)");
    if (set("EMAIL_REDIRECT_TO")) problems.push("EMAIL_REDIRECT_TO must be empty in production: it would send every customer's and authority's email to one inbox");
  }
  // Staging may use Stripe, but only in test mode: its data is synthetic and its money must be too.
  if (deploy === "staging" && set("STRIPE_SECRET_KEY") && !/^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY!.trim())) {
    problems.push("STRIPE_SECRET_KEY must be a test-mode key (sk_test_ or rk_test_) on staging");
  }
  // Staging's QuickBooks connects only to Intuit's sandbox companies, never a real company's books.
  if (deploy === "staging" && set("QUICKBOOKS_CLIENT_ID") && env.QUICKBOOKS_ENVIRONMENT?.trim() === "production") {
    problems.push('QUICKBOOKS_ENVIRONMENT must be "sandbox" on staging');
  }
  // Staging's texts go to one test phone, never to a customer; production's never to one phone.
  // (In demo mode Twilio's keys are unused unless DEMO_LIVE_SERVICES lists sms, which checks this itself.)
  if (deploy === "staging" && set("TWILIO_ACCOUNT_SID") && env.DEMO_MODE?.trim().toLowerCase() !== "true") missing(["SMS_REDIRECT_TO"], "on staging when Twilio is configured, so test texts never reach a real customer");
  if (deploy === "production" && set("SMS_REDIRECT_TO")) problems.push("SMS_REDIRECT_TO must be empty in production: it would send every customer's texts to one phone");
  if (deploy === "production" && set("DEMO_LIVE_SERVICES")) problems.push("DEMO_LIVE_SERVICES is for the staging demo only; leave it empty in production");
  if (deploy === "staging" && set("RESEND_API_KEY")) missing(["EMAIL_REDIRECT_TO"], "on staging when Resend is configured, so test email never reaches a real authority or customer");
  return problems;
}

/** Throws a ConfigError naming every problem; does nothing outside production. */
export function checkConfig(env: Env = process.env) {
  const problems = configProblems(env);
  if (problems.length) throw new ConfigError(problems);
}
