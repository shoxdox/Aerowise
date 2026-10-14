import type { Metadata } from "next";
import { PublicHomepage } from "@/components/marketing/PublicHomepage";
import { HERO, PUBLIC_HOME_URL } from "@/components/marketing/copy";
import "@/components/marketing/marketing.css";

const title = "Aerowise · Aerobic septic maintenance software for Texas";
const description = "Schedule every maintenance contract, inspect on the phone with or without signal, and get reports ready for your county. Try the demo, no sign-up.";
export const metadata: Metadata = {
  title,
  description,
  metadataBase: new URL(PUBLIC_HOME_URL),
  alternates: { canonical: PUBLIC_HOME_URL },
  // Staging is the chosen public/demo link for this pass. Indexing waits for an approved release/domain decision.
  robots: { index: false, follow: false },
  openGraph: { title, description, url: PUBLIC_HOME_URL, siteName: "Aerowise", type: "website", images: [{ url: HERO.office.src, width: HERO.office.width, height: HERO.office.height, alt: HERO.office.alt }] },
  twitter: { card: "summary_large_image", title, description, images: [HERO.office.src] },
};

export default function MarketingPage() { return <PublicHomepage />; }
