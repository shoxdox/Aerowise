import type { Database } from "@aerowise/db";
import type { TokenCipher } from "./crypto.ts";
import { QuickBooksError, type QuickBooksCompany, type QuickBooksProvider, type Tokens } from "./types.ts";

export interface QuickBooksContext {
  db: Database;
  provider: QuickBooksProvider;
  cipher: TokenCipher;
  now: () => Date;
}

/** Access tokens are refreshed when they have less than this left. */
const REFRESH_MARGIN_MS = 5 * 60_000;

function sealed(ctx: QuickBooksContext, t: Tokens) {
  return {
    accessTokenEnc: ctx.cipher.encrypt(t.accessToken),
    refreshTokenEnc: ctx.cipher.encrypt(t.refreshToken),
    accessExpiresAt: t.accessExpiresAt,
    refreshExpiresAt: t.refreshExpiresAt,
  };
}

/** The QuickBooks this company uses: behind the demo gate, a demo company's is the stand-in. */
async function providerOf(ctx: QuickBooksContext, organizationId: string) {
  return ctx.provider.forOrganization ? ctx.provider.forOrganization(organizationId) : ctx.provider;
}

/**
 * Saves a new connection. Reconnecting the same company keeps every link and the review
 * already done; connecting a different company starts over, since its ids mean nothing here.
 */
export async function saveConnection(
  ctx: QuickBooksContext,
  input: { organizationId: string; userId: string; realmId: string; companyName: string | null; tokens: Tokens; syncFrom: string },
) {
  await ctx.db.transaction().execute(async (trx) => {
    const prev = await trx.selectFrom("quickbooksConnections").selectAll().where("organizationId", "=", input.organizationId).forUpdate().executeTakeFirst();
    const environment = (await providerOf(ctx, input.organizationId)).environment;
    const sameCompany = prev?.realmId === input.realmId && prev.environment === environment;
    if (prev && !sameCompany) {
      await trx.deleteFrom("quickbooksLinks").where("organizationId", "=", input.organizationId).execute();
      await trx.deleteFrom("quickbooksConnections").where("organizationId", "=", input.organizationId).execute();
    }
    const values = {
      environment,
      realmId: input.realmId,
      companyName: input.companyName,
      ...sealed(ctx, input.tokens),
      status: "connected" as const,
      connectedBy: input.userId,
      connectedAt: ctx.now(),
      disconnectedAt: null,
      lastSyncError: null,
      updatedAt: ctx.now(),
    };
    if (prev && sameCompany) {
      await trx.updateTable("quickbooksConnections").set(values).where("organizationId", "=", input.organizationId).execute();
    } else {
      await trx
        .insertInto("quickbooksConnections")
        .values({ organizationId: input.organizationId, ...values, syncFrom: input.syncFrom })
        .execute();
    }
  });
}

export async function markNeedsReauth(db: Database, organizationId: string, message: string, now: Date) {
  await db.updateTable("quickbooksConnections").set({ status: "needs_reauth", lastSyncError: message, updatedAt: now }).where("organizationId", "=", organizationId).where("status", "=", "connected").execute();
}

/**
 * The organization's QuickBooks company with a current access token. Refreshing happens
 * under a row lock, because QuickBooks rotates the refresh token and two workers refreshing
 * at once would leave one holding a token that no longer works. A refusal marks the
 * connection as needing to be connected again.
 */
export async function openCompany(ctx: QuickBooksContext, organizationId: string): Promise<QuickBooksCompany> {
  const conn = await ctx.db.selectFrom("quickbooksConnections").selectAll().where("organizationId", "=", organizationId).executeTakeFirst();
  if (!conn || conn.status !== "connected" || !conn.accessTokenEnc || !conn.refreshTokenEnc) throw new QuickBooksError("auth", "QuickBooks is not connected");
  const provider = await providerOf(ctx, organizationId);
  if (conn.environment !== provider.environment) throw new QuickBooksError("auth", `This server talks to QuickBooks ${provider.environment}, but the connection is to ${conn.environment}. Connect again.`);
  const fresh = conn.accessExpiresAt && conn.accessExpiresAt.getTime() - ctx.now().getTime() > REFRESH_MARGIN_MS;
  if (fresh) return provider.company(conn.realmId, ctx.cipher.decrypt(conn.accessTokenEnc), organizationId);
  try {
    const access = await ctx.db.transaction().execute(async (trx) => {
      const locked = await trx.selectFrom("quickbooksConnections").selectAll().where("organizationId", "=", organizationId).forUpdate().executeTakeFirstOrThrow();
      if (locked.accessExpiresAt && locked.accessTokenEnc && locked.accessExpiresAt.getTime() - ctx.now().getTime() > REFRESH_MARGIN_MS) {
        return ctx.cipher.decrypt(locked.accessTokenEnc);
      }
      const t = await provider.refresh(ctx.cipher.decrypt(locked.refreshTokenEnc!), organizationId);
      await trx.updateTable("quickbooksConnections").set({ ...sealed(ctx, t), updatedAt: ctx.now() }).where("organizationId", "=", organizationId).execute();
      return t.accessToken;
    });
    return provider.company(conn.realmId, access, organizationId);
  } catch (err) {
    if (err instanceof QuickBooksError && err.kind === "auth") await markNeedsReauth(ctx.db, organizationId, err.message, ctx.now());
    throw err;
  }
}

/** Stops syncing and gives the tokens back to Intuit. Links are kept for a reconnect. */
export async function disconnect(ctx: QuickBooksContext, organizationId: string) {
  const conn = await ctx.db.selectFrom("quickbooksConnections").select(["refreshTokenEnc"]).where("organizationId", "=", organizationId).executeTakeFirst();
  if (!conn) return;
  if (conn.refreshTokenEnc) {
    try {
      await (await providerOf(ctx, organizationId)).revoke(ctx.cipher.decrypt(conn.refreshTokenEnc), organizationId);
    } catch {
      // Revoking is a courtesy; the tokens are deleted here regardless.
    }
  }
  await ctx.db
    .updateTable("quickbooksConnections")
    .set({ status: "disconnected", accessTokenEnc: null, refreshTokenEnc: null, accessExpiresAt: null, refreshExpiresAt: null, disconnectedAt: ctx.now(), syncLockUntil: null, updatedAt: ctx.now() })
    .where("organizationId", "=", organizationId)
    .execute();
}
