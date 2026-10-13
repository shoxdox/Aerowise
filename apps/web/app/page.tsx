import type { Metadata } from "next";
import { PublicHomepage } from "@/components/marketing/PublicHomepage";
import { HERO, PUBLIC_HOME_URL } from "@/components/marketing/copy";
import "@/components/marketing/marketing.css";

const description = "Early-access software for Texas septic maintenance providers: schedule visits, inspect offline, and prepare reports for provider review. Explore a fictional demo.";
export const metadata: Metadata = {
  title: "Aerowise · Texas septic maintenance, from route to report",
  description,
  metadataBase: new URL(PUBLIC_HOME_URL),
  alternates: { canonical: PUBLIC_HOME_URL },
  // Staging is the chosen public/demo link for this pass. Indexing waits for an approved release/domain decision.
  robots: { index: false, follow: false },
  openGraph: { title: "Aerowise · Route, inspection, office review", description, url: PUBLIC_HOME_URL, siteName: "Aerowise", type: "website", images: [{ url: HERO.shot.src, width: 2560, height: 1190, alt: HERO.shot.alt }] },
  twitter: { card: "summary_large_image", title: "Aerowise · Early access for Texas septic providers", description, images: [HERO.shot.src] },
};

export default function MarketingPage() { return <PublicHomepage />; }
