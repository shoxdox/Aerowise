import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { DemoBanner } from "@/lib/demo";
import "./globals.css";

export const metadata: Metadata = { title: "Aerowise", description: "Aerobic septic maintenance, run in one place.", icons: { icon: "/icons/icon.svg" } };
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <DemoBanner />
        {children}
      </body>
    </html>
  );
}
