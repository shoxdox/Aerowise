import { describe, expect, it } from "vitest";
import { SmsSendError, webhookSignature } from "./provider.ts";
import { TestSmsProvider } from "./test-provider.ts";
import { TwilioSmsProvider } from "./twilio.ts";
import { RedirectingSmsProvider } from "./redirect.ts";
import { smsFromEnv } from "./env.ts";

describe("Twilio request signatures", () => {
  it("match the example Twilio publishes", () => {
    const params = { CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212" };
    expect(webhookSignature("12345", "https://mycompany.com/myapp.php?foo=1&bar=2", params)).toBe("0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
  });

  it("are checked against the exact URL and fields", () => {
    const sms = new TestSmsProvider();
    const url = "https://app.example.test/api/webhooks/sms/inbound";
    const params = { From: "+15125550123", Body: "STOP" };
    const sig = sms.sign(url, params);
    expect(sms.verifyWebhook(url, params, sig)).toBe(true);
    expect(sms.verifyWebhook(url, { ...params, Body: "START" }, sig)).toBe(false);
    expect(sms.verifyWebhook(`${url}?x=1`, params, sig)).toBe(false);
    expect(sms.verifyWebhook(url, params, "nope")).toBe(false);
  });
});

describe("TwilioSmsProvider", () => {
  it("posts the message to the account's Messages resource", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const twilio = new TwilioSmsProvider({ accountSid: "AC123", authToken: "secret" }, async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response(JSON.stringify({ sid: "SM42", status: "queued" }), { status: 201 });
    });
    const r = await twilio.send({ from: "+15125550100", to: "+15125550123", body: "Hello", statusCallback: "https://x.test/api/webhooks/sms/status" });
    expect(r).toEqual({ providerMessageId: "SM42", status: "sent" });
    expect(calls[0]!.url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from("AC123:secret").toString("base64")}`);
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]!.init.body)))).toEqual({
      To: "+15125550123",
      From: "+15125550100",
      Body: "Hello",
      StatusCallback: "https://x.test/api/webhooks/sms/status",
    });
  });

  it("tells a refusal that can be retried from one that cannot", async () => {
    const answer = (status: number, body: object) => new TwilioSmsProvider({ accountSid: "AC1", authToken: "t" }, async () => new Response(JSON.stringify(body), { status }));
    const err = (p: TwilioSmsProvider) => p.send({ from: "+15125550100", to: "+15125550123", body: "x", statusCallback: null }).catch((e: SmsSendError) => e);
    expect(await err(answer(400, { code: 21610, message: "unsubscribed" }))).toMatchObject({ code: "21610", permanent: true });
    expect(await err(answer(429, { code: 20429, message: "Too many requests" }))).toMatchObject({ permanent: false });
    expect(await err(answer(503, {}))).toMatchObject({ code: "http_503", permanent: false });
    const down = new TwilioSmsProvider({ accountSid: "AC1", authToken: "t" }, async () => {
      throw new Error("ECONNRESET");
    });
    expect(await err(down)).toMatchObject({ code: "network", permanent: false });
  });
});

describe("RedirectingSmsProvider (staging)", () => {
  it("sends every text to the one test phone, saying who it was for", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const twilio = new TwilioSmsProvider({ accountSid: "AC123", authToken: "secret" }, async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response(JSON.stringify({ sid: "SM1", status: "queued" }), { status: 201 });
    });
    const sms = new RedirectingSmsProvider(twilio, "+15125550199");
    expect(sms.kind).toBe("twilio");
    await sms.send({ from: "+15125550100", to: "+15125550123", body: "Your service is tomorrow.", statusCallback: null });
    const sent = Object.fromEntries(new URLSearchParams(String(calls[0]!.init.body)));
    expect(sent).toMatchObject({ To: "+15125550199", From: "+15125550100", Body: "[Test, for +15125550123] Your service is tomorrow." });
  });

  it("refuses anything but one phone number", () => {
    const inner = new TestSmsProvider();
    for (const bad of ["5125550199", "+1 512 555 0199", "+15125550199,+15125550198", ""]) expect(() => new RedirectingSmsProvider(inner, bad)).toThrow(/SMS_REDIRECT_TO/);
  });

  it("is used whenever SMS_REDIRECT_TO is set with Twilio", () => {
    const keys = { TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t" };
    expect(smsFromEnv({ ...keys, SMS_REDIRECT_TO: "+15125550199" }, true)?.provider).toBeInstanceOf(RedirectingSmsProvider);
    expect(smsFromEnv(keys, true)?.provider).toBeInstanceOf(TwilioSmsProvider);
  });
});
