import { PLATFORM_ADMIN_MIN_PASSWORD } from "@aerowise/domain";
import type { Database } from "./client.ts";
import { hashPassword } from "./password.ts";

/**
 * Creates a platform admin: the only way one comes to exist outside development, run
 * by the operator through `cli.ts create-platform-admin`. Fails if the email is taken.
 */
export async function createPlatformAdmin(db: Database, input: { name: string; email: string; password: string }) {
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  if (!name) throw new Error("a name is required");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error(`not an email address: ${input.email}`);
  if (input.password.length < PLATFORM_ADMIN_MIN_PASSWORD) {
    throw new Error(`the password must be at least ${PLATFORM_ADMIN_MIN_PASSWORD} characters`);
  }
  const existing = await db
    .selectFrom("platformAdmins")
    .select("id")
    .where((eb) => eb(eb.fn("lower", ["email"]), "=", email))
    .executeTakeFirst();
  if (existing) throw new Error(`a platform admin with email ${email} already exists`);
  return db
    .insertInto("platformAdmins")
    .values({ name, email, passwordHash: await hashPassword(input.password) })
    .returning(["id", "email"])
    .executeTakeFirstOrThrow();
}
