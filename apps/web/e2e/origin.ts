// The web app's address in these tests (playwright.config.ts picks the port).
export const ORIGIN = `http://localhost:${process.env.E2E_WEB_PORT ?? "3000"}`;

/** A link the API wrote (email, invitation) pointed at this test run's web app. */
export const local = (link: string) => link.replace(/^https?:\/\/[^/]+/, ORIGIN);
