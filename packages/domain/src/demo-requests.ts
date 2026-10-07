import { z } from "zod";

// W8.2: a prospect asks for a demo from the public marketing page. Platform-wide (no
// organization yet); only platform admins see these, in /admin.

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) =>
  text(max)
    .optional()
    .transform((v) => (v ? v : undefined));

export const demoRequestInput = z.object({
  name: text(120).min(1, "Enter your name"),
  email: z.email("Enter a valid email address").max(320).transform((e) => e.trim().toLowerCase()),
  company: text(160).min(1, "Enter your company's name"),
  phone: optionalText(40),
  counties: optionalText(300),
  message: optionalText(2000),
  /**
   * Spam trap: a field people never see or fill in. A request that fills it is answered
   * like any other and then dropped.
   */
  website: z.string().max(500).optional(),
});
export type DemoRequestInput = z.input<typeof demoRequestInput>;

/**
 * Where an accepted email went: kept in the local test outbox (a stand-in; nobody received
 * it) or accepted by a mail provider. Only the second is shown as emailed.
 */
export const EMAIL_DELIVERIES = ["outbox", "provider"] as const;
export const emailDelivery = z.enum(EMAIL_DELIVERIES);
export type EmailDeliveryKind = z.infer<typeof emailDelivery>;

export const DEMO_REQUEST_STATUSES = ["new", "handled"] as const;

export const demoRequest = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  company: z.string(),
  phone: z.string().nullable(),
  counties: z.string().nullable(),
  message: z.string().nullable(),
  status: z.enum(DEMO_REQUEST_STATUSES),
  notifiedAt: z.iso.datetime({ offset: true }).nullable(),
  notifyError: z.string().nullable(),
  /** Where the alert went, once sent. Null when not sent, or sent before this was recorded. */
  notifyDelivery: emailDelivery.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type DemoRequest = z.infer<typeof demoRequest>;

export const demoRequestStatusInput = z.object({ status: z.enum(DEMO_REQUEST_STATUSES) });
