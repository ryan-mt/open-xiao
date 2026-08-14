import type { Metadata, Viewport } from "next";
import { Archivo, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
});

const ibmPlexMono = IBM_Plex_Mono({
  variable: "--font-ibm-plex-mono",
  weight: ["400", "500", "600"],
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
  ),
  title: {
    default: "Open Xiao | Run agents. Stay in command.",
    template: "%s | Open Xiao",
  },
  description:
    "Open Xiao is a local Windows workspace for coding with Grok and OpenAI models, project tools, Git, planning, and review.",
  applicationName: "Open Xiao",
  keywords: [
    "Open Xiao",
    "coding agent",
    "Tauri",
    "React",
    "OpenAI",
    "Grok",
  ],
  alternates: {
    canonical: "/",
  },
  icons: {
    icon: "/favicon.png",
    apple: "/xiao-mark.png",
  },
  openGraph: {
    type: "website",
    title: "Open Xiao | Run agents. Stay in command.",
    description:
      "Models, project tools, Git, and review in one local Windows workspace.",
    siteName: "Open Xiao",
    images: [
      {
        url: "/og.jpg",
        width: 1200,
        height: 630,
        alt: "Smoked acrylic planes organized around one local control point.",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Open Xiao | Run agents. Stay in command.",
    description:
      "Models, project tools, Git, and review in one local Windows workspace.",
    images: ["/og.jpg"],
  },
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2f3ed" },
    { media: "(prefers-color-scheme: dark)", color: "#0d0f0c" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${archivo.variable} ${ibmPlexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
