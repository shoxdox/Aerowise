import { createHash } from "node:crypto";
import type { Database } from "@aerowise/db";
import { LOGO_TYPES, MAX_LOGO_BYTES, organizationSettings, organizationSettingsPatch, type OrganizationSettings } from "@aerowise/domain";
import type { ObjectStore } from "@aerowise/storage";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { audit } from "../lib/audit.ts";
import { HttpError, notFound } from "../lib/errors.ts";

// The first bytes of each accepted logo type, so a renamed file of another kind is refused.
const MAGIC: Record<(typeof LOGO_TYPES)[number], number[]> = {
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "image/jpeg": [0xff, 0xd8, 0xff],
};

export const organizationRoutes: FastifyPluginAsyncZod<{ db: Database; store: ObjectStore }> = async (app, { db, store }) => {
  app.addContentTypeParser([...LOGO_TYPES], { parseAs: "buffer", bodyLimit: MAX_LOGO_BYTES }, (_req, body, done) => done(null, body));

  async function load(organizationId: string): Promise<OrganizationSettings> {
    const org = await db
      .selectFrom("organizations as o")
      .leftJoin("providerCredentials as pc", (j) => j.onRef("pc.id", "=", "o.responsibleCredentialId").onRef("pc.organizationId", "=", "o.id"))
      .select([
        "o.name",
        "o.phone",
        "o.email",
        "o.addressLine1",
        "o.addressLine2",
        "o.city",
        "o.state",
        "o.postalCode",
        "o.serviceCounties",
        "o.billFilingFees",
        "o.timezone",
        "o.logoStorageKey",
        "pc.id as credentialId",
        "pc.holderName",
        "pc.number",
      ])
      .where("o.id", "=", organizationId)
      .executeTakeFirstOrThrow();
    const { logoStorageKey, credentialId, holderName, number, ...rest } = org;
    return {
      ...rest,
      hasLogo: !!logoStorageKey,
      responsibleProvider: credentialId && holderName && number ? { id: credentialId, holderName, number } : null,
    };
  }

  app.get(
    "/organization/settings",
    {
      config: { permission: "self:read" },
      schema: { tags: ["organization"], summary: "Company details, service counties and the responsible MP", response: { 200: organizationSettings } },
    },
    async (req) => load(req.requireAuth().organizationId),
  );

  app.patch(
    "/organization/settings",
    {
      config: { permission: "org:manage" },
      schema: { tags: ["organization"], summary: "Edit company details and service counties", body: organizationSettingsPatch, response: { 200: organizationSettings } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const changes = Object.fromEntries(Object.entries(req.body).filter(([, v]) => v !== undefined));
      if (Object.keys(changes).length) {
        await db.transaction().execute(async (trx) => {
          await trx.updateTable("organizations").set(changes).where("id", "=", organizationId).execute();
          await audit(trx, req, { action: "organization.updated", entityType: "organization", entityId: organizationId, changes });
        });
      }
      return load(organizationId);
    },
  );

  app.put(
    "/organization/logo",
    {
      config: { permission: "org:manage", imageUpload: true },
      bodyLimit: MAX_LOGO_BYTES,
      schema: {
        tags: ["organization"],
        summary: "Upload the company logo (PNG or JPEG, up to 1 MB) as the raw image body",
        description: "Shown at the top of new customer and authority reports. Reports already made keep the logo they were made with.",
        response: { 200: organizationSettings },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const contentType = (req.headers["content-type"] ?? "").split(";")[0]!.trim() as (typeof LOGO_TYPES)[number];
      const body = req.body as Buffer;
      const magic = MAGIC[contentType];
      if (!magic || !Buffer.isBuffer(body) || body.length < magic.length || !magic.every((b, i) => body[i] === b)) {
        throw new HttpError(422, "invalid_logo", "Upload a PNG or JPEG image");
      }
      const sha256 = createHash("sha256").update(body).digest("hex");
      const key = `${organizationId}/logos/${sha256}.${contentType === "image/png" ? "png" : "jpg"}`;
      await store.put(key, body, contentType);
      await db.transaction().execute(async (trx) => {
        await trx.updateTable("organizations").set({ logoStorageKey: key, logoContentType: contentType }).where("id", "=", organizationId).execute();
        await audit(trx, req, { action: "organization.logo_changed", entityType: "organization", entityId: organizationId, changes: { sha256, bytes: body.length } });
      });
      return load(organizationId);
    },
  );

  app.post(
    "/organization/logo/remove",
    {
      config: { permission: "org:manage" },
      schema: { tags: ["organization"], summary: "Stop showing a logo on new reports", body: z.object({}).optional(), response: { 200: organizationSettings } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      await db.transaction().execute(async (trx) => {
        await trx.updateTable("organizations").set({ logoStorageKey: null, logoContentType: null }).where("id", "=", organizationId).execute();
        await audit(trx, req, { action: "organization.logo_removed", entityType: "organization", entityId: organizationId });
      });
      return load(organizationId);
    },
  );

  app.get(
    "/organization/logo",
    { config: { permission: "self:read" }, schema: { tags: ["organization"], summary: "The company logo image" } },
    async (req, reply) => {
      const { organizationId } = req.requireAuth();
      const org = await db.selectFrom("organizations").select(["logoStorageKey", "logoContentType"]).where("id", "=", organizationId).executeTakeFirstOrThrow();
      const data = org.logoStorageKey ? await store.get(org.logoStorageKey) : null;
      if (!data || !org.logoContentType) throw notFound("Logo");
      return reply.type(org.logoContentType).send(data);
    },
  );
};
