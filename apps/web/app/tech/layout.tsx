import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./tech.css";

export const metadata: Metadata = {
  title: "Aerowise Technician",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icons/icon.svg", apple: "/icons/icon.svg" },
  appleWebApp: { capable: true, title: "Aerowise", statusBarStyle: "default" },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#1f6f5c" };

export default function TechLayout({ children }: { children: ReactNode }) {
  return <div className="tech">{children}</div>;
}
