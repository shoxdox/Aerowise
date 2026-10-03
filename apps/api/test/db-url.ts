export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set. See .env.example.");
  if (!/test/.test(new URL(url).pathname)) throw new Error("TEST_DATABASE_URL must name a database containing 'test'");
  return url;
}
