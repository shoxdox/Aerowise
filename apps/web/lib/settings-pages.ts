import { roleHasPermission } from "@aerowise/domain";
import { canEdit, isSupportView, type Me } from "./session";

export interface SettingsPage {
  href: string;
  label: string;
  /** One line on the settings index: what the page is for. */
  about: string;
}

/**
 * The settings pages this person can open, in the order the index shows them. The office
 * menu shows one "Settings" link when there is at least one; the API enforces access regardless.
 */
export function settingsPages(me: Me, features: { serviceItems: boolean; pumping: boolean }): SettingsPage[] {
  const can = (permission: Parameters<typeof roleHasPermission>[1]) => roleHasPermission(me.role, permission);
  const office = canEdit(me) || isSupportView(me);
  const owner = me.role === "owner";
  return [
    ...(office ? [{ href: "/settings/company", label: "Company", about: "Name, contact details and time zone, shown to customers and on reports." }] : []),
    ...(office ? [{ href: "/settings/users", label: "Users", about: "Who can sign in, their roles and invitations." }] : []),
    ...(office ? [{ href: "/settings/credentials", label: "Licenses and registrations", about: "Maintenance provider and technician licenses, and who signs reports." }] : []),
    ...(features.serviceItems && can("invoices:write") ? [{ href: "/settings/service-items", label: "Service items", about: "The catalog work orders and invoices are priced from." }] : []),
    ...(features.pumping && can("work:write") ? [{ href: "/settings/trucks", label: "Trucks and facilities", about: "Pump trucks and the disposal facilities loads go to." }] : []),
    ...(office ? [{ href: "/settings/routing", label: "Route settings", about: "Where the day starts, stop lengths and how routes are estimated." }] : []),
    ...(owner ? [{ href: "/settings/billing", label: "Billing", about: "Online card and bank payments from customers, through Stripe." }] : []),
    ...(owner ? [{ href: "/settings/subscription", label: "Aerowise subscription", about: "What the company pays Aerowise, and its payment method." }] : []),
    ...(owner ? [{ href: "/settings/export", label: "Export your data", about: "Everything the company has in Aerowise, as files you keep." }] : []),
  ];
}
