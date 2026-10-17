import { roleHasPermission } from "@aerowise/domain";
import { canEdit, isSupportView, type Me } from "./session";

export const SETTINGS_GROUPS = ["Your company", "Work and routes", "Customers and payments"] as const;

export interface SettingsPage {
  href: string;
  label: string;
  /** One line on the settings index: what the page is for. */
  about: string;
  /** The heading it sits under on the index. */
  group: (typeof SETTINGS_GROUPS)[number];
}

/**
 * Everything this person can set up, in the order the index shows it, including the settings
 * that live on their own screens (renewals, texts, QuickBooks), so the index is the one place to
 * look. The office menu shows one "Settings" link when there is at least one; the API enforces
 * access regardless.
 */
export function settingsPages(me: Me, features: { serviceItems: boolean; pumping: boolean }): SettingsPage[] {
  const can = (permission: Parameters<typeof roleHasPermission>[1]) => roleHasPermission(me.role, permission);
  const office = canEdit(me) || isSupportView(me);
  const owner = me.role === "owner";
  const pages: (SettingsPage & { shown: boolean })[] = [
    { shown: office, group: "Your company", href: "/settings/company", label: "Company", about: "Name, phone, address, logo and license, shown to customers and on reports." },
    { shown: office, group: "Your company", href: "/settings/users", label: "Users", about: "Who can sign in, their roles and invitations." },
    { shown: office, group: "Your company", href: "/settings/credentials", label: "Licenses and registrations", about: "Maintenance provider and technician licenses, and who signs reports." },
    { shown: owner, group: "Your company", href: "/settings/subscription", label: "Aerowise subscription", about: "What the company pays Aerowise, and its payment method." },
    { shown: owner, group: "Your company", href: "/settings/export", label: "Export your data", about: "Everything the company has in Aerowise, as files you keep." },
    { shown: features.serviceItems && can("invoices:write"), group: "Work and routes", href: "/settings/service-items", label: "Service items", about: "The catalog work orders and invoices are priced from." },
    { shown: features.pumping && can("work:write"), group: "Work and routes", href: "/settings/trucks", label: "Trucks and facilities", about: "Pump trucks and the disposal facilities loads go to." },
    { shown: office, group: "Work and routes", href: "/settings/routing", label: "Route settings", about: "Where the day starts, stop lengths and how routes are estimated." },
    { shown: office, group: "Customers and payments", href: "/renewals", label: "Renewals and agreement", about: "When renewals go out, the add-ons offered and the agreement customers sign." },
    { shown: can("sms:write"), group: "Customers and payments", href: "/sms", label: "Text messages", about: "Turn texting on, and see what was sent and who replied STOP." },
    { shown: owner, group: "Customers and payments", href: "/settings/billing", label: "Billing", about: "Card and bank payments from customers through Stripe, invoice payment terms and sales tax." },
    { shown: can("quickbooks:write"), group: "Customers and payments", href: "/quickbooks", label: "QuickBooks", about: "Connect QuickBooks Online and match its products, services and sales tax." },
  ];
  return pages.filter((p) => p.shown).map(({ shown: _, ...page }) => page);
}
