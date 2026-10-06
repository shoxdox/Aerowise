import type { Metadata } from "next";
import { LegalDocumentPage } from "@/components/legal/LegalDocumentPage";

export const metadata: Metadata = { title: "Terms of service · Aerowise" };

export default function TermsPage() {
  return <LegalDocumentPage document="terms" />;
}
