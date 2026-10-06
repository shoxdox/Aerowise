import type { BillingInvoiceInput, BillingProvider } from "@aerowise/billing";
import type { EmailMessage, EmailTransport } from "@aerowise/compliance";
import type { Database } from "@aerowise/db";
import { isFictionalEmail } from "@aerowise/domain";
import type { CheckoutInput, PaymentProvider, RefundInput } from "@aerowise/payments";
import type { QuickBooksProvider } from "@aerowise/quickbooks";
import type { SmsProvider, SmsSendInput } from "@aerowise/sms";

// A demo company (organizations.demo) is fictional, and nothing it does may reach a real outside
// service, whatever keys or DEMO_LIVE_SERVICES the deployment has. Each gate below stands in front
// of one real service and sends a demo company's calls to that service's stand-in instead. The
// API's routes and the worker's queued jobs all reach outside services through these, so there
// is no screen to get around: the decision is made here, on the server, for every call.
//
// A call is a demo company's when it names that company, or when it names something only a
// stand-in hands out (a test account, customer, QuickBooks company or token): a demo company is
// only ever given stand-in ones, because the calls that hand them out all name the company.

/** Whether a company is a demo company. The flag never changes, so answers are kept. */
export type DemoCheck = (organizationId: string | null | undefined) => Promise<boolean>;

export function demoCheck(db: Database): DemoCheck {
  const known = new Map<string, boolean>();
  return async (organizationId) => {
    if (!organizationId) return false;
    const hit = known.get(organizationId);
    if (hit !== undefined) return hit;
    const row = await db.selectFrom("organizations").select("demo").where("id", "=", organizationId).executeTakeFirst();
    // An unknown company is not cached: it may be one being made in this same transaction.
    if (!row) return false;
    known.set(organizationId, row.demo);
    return row.demo;
  };
}

/** Ids the Stripe stand-ins hand out (acct_test_…, cus_test_…, in_test_…); real Stripe ids never contain `_test_`. */
export const isStandInStripeId = (id: string | null | undefined) => /^[a-z]+_test_[0-9a-f]{24}$/.test(id ?? "");
/** The QuickBooks stand-in's companies are `test-…`, its tokens `qbt_…`. */
const isStandInRealm = (realmId: string) => realmId.startsWith("test-");
const isStandInToken = (token: string) => token.startsWith("qbt_");

/** Email: a demo company's mail, and mail to made-up addresses, goes to the outbox. */
export class DemoGatedTransport implements EmailTransport {
  constructor(
    readonly live: EmailTransport,
    readonly standIn: EmailTransport,
    private readonly isDemo: DemoCheck,
  ) {}
  get name() {
    return this.live.name;
  }
  async send(m: EmailMessage) {
    // Mail with no company (a password reset, say) to a made-up address is a demo person's.
    const fictional = (await this.isDemo(m.organizationId)) || isFictionalEmail(m.to);
    return (fictional ? this.standIn : this.live).send(m);
  }
}

/** Stripe Connect (homeowner payments). Webhooks are only ever the real service's. */
export class DemoGatedPayments implements PaymentProvider {
  constructor(
    readonly live: PaymentProvider,
    readonly standIn: PaymentProvider,
    private readonly isDemo: DemoCheck,
  ) {}
  get kind() {
    return this.live.kind;
  }
  /** Which one a company uses (for screens that say test mode or live). */
  async forOrganization(organizationId: string) {
    return (await this.isDemo(organizationId)) ? this.standIn : this.live;
  }
  private byAccount = (accountId: string) => (isStandInStripeId(accountId) ? this.standIn : this.live);
  async createAccount(input: { organizationId: string; name: string; email: string | null }) {
    return ((await this.isDemo(input.organizationId)) ? this.standIn : this.live).createAccount(input);
  }
  accountLink(input: { accountId: string; refreshUrl: string; returnUrl: string }) {
    return this.byAccount(input.accountId).accountLink(input);
  }
  getAccount(accountId: string) {
    return this.byAccount(accountId).getAccount(accountId);
  }
  async createCheckout(input: CheckoutInput) {
    const demo = (await this.isDemo(input.metadata.organizationId)) || isStandInStripeId(input.accountId);
    return (demo ? this.standIn : this.live).createCheckout(input);
  }
  expireCheckout(input: { accountId: string; sessionId: string }) {
    return this.byAccount(input.accountId).expireCheckout(input);
  }
  createRefund(input: RefundInput) {
    return this.byAccount(input.accountId).createRefund(input);
  }
  parseWebhook(rawBody: Buffer | string, signature: string) {
    return this.live.parseWebhook(rawBody, signature);
  }
}

/** Stripe Billing (what companies pay Aerowise). Webhooks are only ever the real service's. */
export class DemoGatedBilling implements BillingProvider {
  constructor(
    readonly live: BillingProvider,
    readonly standIn: BillingProvider,
    private readonly isDemo: DemoCheck,
  ) {}
  get kind() {
    return this.live.kind;
  }
  /** Which one a company uses (for screens that say test mode or live). */
  async forOrganization(organizationId: string) {
    return (await this.isDemo(organizationId)) ? this.standIn : this.live;
  }
  private byId = (id: string) => (isStandInStripeId(id) ? this.standIn : this.live);
  async createCustomer(input: { organizationId: string; name: string; email: string | null }) {
    return ((await this.isDemo(input.organizationId)) ? this.standIn : this.live).createCustomer(input);
  }
  async createInvoice(input: BillingInvoiceInput) {
    const demo = (await this.isDemo(input.metadata.organizationId)) || isStandInStripeId(input.customerId);
    return (demo ? this.standIn : this.live).createInvoice(input);
  }
  paymentMethod(customerId: string) {
    return this.byId(customerId).paymentMethod(customerId);
  }
  retryInvoice(invoiceId: string) {
    return this.byId(invoiceId).retryInvoice(invoiceId);
  }
  managePaymentMethod(input: { customerId: string; returnUrl: string }) {
    return this.byId(input.customerId).managePaymentMethod(input);
  }
  parseWebhook(rawBody: Buffer | string, signature: string) {
    return this.live.parseWebhook(rawBody, signature);
  }
}

/** QuickBooks Online. A demo company connects to the stand-in company, and only to it. */
export class DemoGatedQuickBooks implements QuickBooksProvider {
  constructor(
    readonly live: QuickBooksProvider,
    readonly standIn: QuickBooksProvider,
    private readonly isDemo: DemoCheck,
  ) {}
  get kind() {
    return this.live.kind;
  }
  get environment() {
    return this.live.environment;
  }
  /** Which one a company uses, for screens that say which QuickBooks is connected. */
  async forOrganization(organizationId: string) {
    return (await this.isDemo(organizationId)) ? this.standIn : this.live;
  }
  // authorizeUrl must answer at once, so the route asks forOrganization first (see quickbooks.ts);
  // called directly, it can only go by the stand-in's own companies.
  authorizeUrl(input: { state: string; redirectUri: string; organizationId: string }) {
    return this.live.authorizeUrl(input);
  }
  async exchangeCode(input: { code: string; realmId: string; redirectUri: string; organizationId: string }) {
    // The company comes from the signed state, so a demo company cannot swap in a real code.
    const demo = (await this.isDemo(input.organizationId)) || isStandInRealm(input.realmId);
    return (demo ? this.standIn : this.live).exchangeCode(input);
  }
  refresh(refreshToken: string) {
    return (isStandInToken(refreshToken) ? this.standIn : this.live).refresh(refreshToken);
  }
  revoke(refreshToken: string) {
    return (isStandInToken(refreshToken) ? this.standIn : this.live).revoke(refreshToken);
  }
  company(realmId: string, accessToken: string) {
    return (isStandInRealm(realmId) || isStandInToken(accessToken) ? this.standIn : this.live).company(realmId, accessToken);
  }
}

/** Texts. Replies and receipts are only ever the real service's. */
export class DemoGatedSms implements SmsProvider {
  constructor(
    readonly live: SmsProvider,
    readonly standIn: SmsProvider,
    private readonly isDemo: DemoCheck,
  ) {}
  get kind() {
    return this.live.kind;
  }
  /** Which one a company uses (for screens that say test mode or live). */
  async forOrganization(organizationId: string) {
    return (await this.isDemo(organizationId)) ? this.standIn : this.live;
  }
  async send(input: SmsSendInput) {
    return ((await this.isDemo(input.organizationId)) ? this.standIn : this.live).send(input);
  }
  verifyWebhook(url: string, params: Record<string, string>, signature: string) {
    return this.live.verifyWebhook(url, params, signature);
  }
}

/**
 * The service a company actually uses: behind a gate, the stand-in for a demo company and the
 * real one otherwise; without a gate, the one configured. For screens that say "test mode".
 */
export async function providerFor<T extends object>(provider: T, organizationId: string): Promise<T> {
  const gate = provider as { forOrganization?: (organizationId: string) => Promise<T> };
  return typeof gate.forOrganization === "function" ? gate.forOrganization(organizationId) : provider;
}
