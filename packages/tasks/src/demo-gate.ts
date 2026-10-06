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
// Every call names the company it is for, taken by the caller from the record that owns the
// work (the signed-in session's company, the invoice, the connection, the queued task), and the
// gate looks that company's demo flag up in the database. Nothing a visitor sends, and nothing
// about how an id looks, decides it. A call for no company, or for a company that is not on
// record, fails closed: it goes to the stand-in.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a company must stay on the stand-ins: a demo company, no company, or one not on record. */
export interface DemoCheck {
  (organizationId: string | null | undefined): Promise<boolean>;
  /** What is already known without asking the database: false only for a company looked up as real. */
  known(organizationId: string): boolean | undefined;
}

/** Looks the demo flag up on the company's record. Answers are kept: the flag never changes. */
export function demoCheck(db: Database): DemoCheck {
  const known = new Map<string, boolean>();
  const check = async (organizationId: string | null | undefined) => {
    if (!organizationId || !UUID.test(organizationId)) return true;
    const hit = known.get(organizationId);
    if (hit !== undefined) return hit;
    const row = await db.selectFrom("organizations").select("demo").where("id", "=", organizationId).executeTakeFirst();
    // Not on record (or not yet committed): not kept, and kept off the real services.
    if (!row) return true;
    known.set(organizationId, row.demo);
    return row.demo;
  };
  return Object.assign(check, { known: (organizationId: string) => known.get(organizationId) });
}

/** A gate's choice for one company: the stand-in unless the company is on record as real. */
abstract class Gate<T> {
  constructor(
    readonly live: T,
    readonly standIn: T,
    protected readonly isDemo: DemoCheck,
  ) {}
  /** Which one a company uses (also for screens that say test mode or live). */
  async forOrganization(organizationId: string | null | undefined): Promise<T> {
    return (await this.isDemo(organizationId)) ? this.standIn : this.live;
  }
  /** The same, for calls that must answer at once: the real one only for a company already looked up as real. */
  protected knownFor(organizationId: string): T {
    return this.isDemo.known(organizationId) === false ? this.live : this.standIn;
  }
}

/**
 * Email. Mail for a company follows that company. Mail for no company (a password reset, an
 * alert to Aerowise) goes out for real unless it is to a made-up address or to someone who
 * belongs to a demo company.
 */
export class DemoGatedTransport extends Gate<EmailTransport> implements EmailTransport {
  constructor(
    live: EmailTransport,
    standIn: EmailTransport,
    isDemo: DemoCheck,
    private readonly db: Database,
  ) {
    super(live, standIn, isDemo);
  }
  get name() {
    return this.live.name;
  }
  async send(m: EmailMessage) {
    const transport = m.organizationId ? await this.forOrganization(m.organizationId) : (await this.demoPerson(m.to)) ? this.standIn : this.live;
    return transport.send(m);
  }
  private async demoPerson(to: string) {
    if (isFictionalEmail(to)) return true;
    const member = await this.db
      .selectFrom("users as u")
      .innerJoin("memberships as m", "m.userId", "u.id")
      .innerJoin("organizations as o", "o.id", "m.organizationId")
      .select("o.id")
      .where((eb) => eb(eb.fn("lower", ["u.email"]), "=", to.trim().toLowerCase()))
      .where("o.demo", "=", true)
      .executeTakeFirst();
    return !!member;
  }
}

/** Stripe Connect (homeowner payments). Webhooks are only ever the real service's. */
export class DemoGatedPayments extends Gate<PaymentProvider> implements PaymentProvider {
  get kind() {
    return this.live.kind;
  }
  async createAccount(input: { organizationId: string; name: string; email: string | null }) {
    return (await this.forOrganization(input.organizationId)).createAccount(input);
  }
  async accountLink(input: { organizationId: string; accountId: string; refreshUrl: string; returnUrl: string }) {
    return (await this.forOrganization(input.organizationId)).accountLink(input);
  }
  async getAccount(accountId: string, organizationId: string) {
    return (await this.forOrganization(organizationId)).getAccount(accountId, organizationId);
  }
  async createCheckout(input: CheckoutInput) {
    return (await this.forOrganization(input.metadata.organizationId)).createCheckout(input);
  }
  async expireCheckout(input: { organizationId: string; accountId: string; sessionId: string }) {
    return (await this.forOrganization(input.organizationId)).expireCheckout(input);
  }
  async createRefund(input: RefundInput) {
    return (await this.forOrganization(input.organizationId)).createRefund(input);
  }
  parseWebhook(rawBody: Buffer | string, signature: string) {
    return this.live.parseWebhook(rawBody, signature);
  }
}

/** Stripe Billing (what companies pay Aerowise). Webhooks are only ever the real service's. */
export class DemoGatedBilling extends Gate<BillingProvider> implements BillingProvider {
  get kind() {
    return this.live.kind;
  }
  async createCustomer(input: { organizationId: string; name: string; email: string | null }) {
    return (await this.forOrganization(input.organizationId)).createCustomer(input);
  }
  async createInvoice(input: BillingInvoiceInput) {
    return (await this.forOrganization(input.metadata.organizationId)).createInvoice(input);
  }
  async paymentMethod(customerId: string, organizationId: string) {
    return (await this.forOrganization(organizationId)).paymentMethod(customerId, organizationId);
  }
  async retryInvoice(invoiceId: string, organizationId: string) {
    return (await this.forOrganization(organizationId)).retryInvoice(invoiceId, organizationId);
  }
  async managePaymentMethod(input: { organizationId: string; customerId: string; returnUrl: string }) {
    return (await this.forOrganization(input.organizationId)).managePaymentMethod(input);
  }
  parseWebhook(rawBody: Buffer | string, signature: string) {
    return this.live.parseWebhook(rawBody, signature);
  }
}

/** QuickBooks Online. A demo company connects to the stand-in company, and only to it. */
export class DemoGatedQuickBooks extends Gate<QuickBooksProvider> implements QuickBooksProvider {
  get kind() {
    return this.live.kind;
  }
  get environment() {
    return this.live.environment;
  }
  // Routes and openCompany ask forOrganization first; called directly, these answer at once
  // with what is known, so an unknown company gets the stand-in.
  authorizeUrl(input: { state: string; redirectUri: string; organizationId: string }) {
    return this.knownFor(input.organizationId).authorizeUrl(input);
  }
  company(realmId: string, accessToken: string, organizationId: string) {
    return this.knownFor(organizationId).company(realmId, accessToken, organizationId);
  }
  async exchangeCode(input: { code: string; realmId: string; redirectUri: string; organizationId: string }) {
    // The company comes from the signed state, so a demo company cannot swap in a real code.
    return (await this.forOrganization(input.organizationId)).exchangeCode(input);
  }
  async refresh(refreshToken: string, organizationId: string) {
    return (await this.forOrganization(organizationId)).refresh(refreshToken, organizationId);
  }
  async revoke(refreshToken: string, organizationId: string) {
    return (await this.forOrganization(organizationId)).revoke(refreshToken, organizationId);
  }
}

/** Texts. Replies and receipts are only ever the real service's. */
export class DemoGatedSms extends Gate<SmsProvider> implements SmsProvider {
  get kind() {
    return this.live.kind;
  }
  async send(input: SmsSendInput) {
    return (await this.forOrganization(input.organizationId)).send(input);
  }
  verifyWebhook(url: string, params: Record<string, string>, signature: string) {
    return this.live.verifyWebhook(url, params, signature);
  }
}

/**
 * The service a company actually uses: behind a gate, the stand-in unless the company is on
 * record as real; without a gate, the one configured. For screens that say "test mode".
 */
export async function providerFor<T extends object>(provider: T, organizationId: string): Promise<T> {
  const gate = provider as { forOrganization?: (organizationId: string) => Promise<T> };
  return typeof gate.forOrganization === "function" ? gate.forOrganization(organizationId) : provider;
}
