import type { Metadata } from "next";
import localFont from "next/font/local";
import { headers } from "next/headers";
import "./globals.css";

const bitter = localFont({
  src: "./fonts/Bitter-Variable.ttf",
  variable: "--font-bitter",
  display: "swap",
  style: "normal",
  weight: "100 900",
});

const oswald = localFont({
  src: "./fonts/Oswald-Variable.ttf",
  variable: "--font-oswald",
  display: "swap",
  style: "normal",
  weight: "200 700",
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const forwardedHost = requestHeaders.get("x-forwarded-host");
  const directHost = requestHeaders.get("host");
  const candidateHost = (forwardedHost ?? directHost ?? "localhost:3001").trim();
  const host = /^[a-z0-9.-]+(?::\d+)?$/i.test(candidateHost)
    ? candidateHost
    : "localhost:3001";
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto");
  const protocol =
    forwardedProtocol === "http" || forwardedProtocol === "https"
      ? forwardedProtocol
      : host.startsWith("localhost")
        ? "http"
        : "https";
  const metadataBase = new URL(`${protocol}://${host}`);
  const socialImage = new URL("/og.png", metadataBase).toString();

  return {
    metadataBase,
    title: "RailScout — dostępność miejsc we wszystkich połączeniach",
    description:
      "Sprawdź dokładne numery wolnych miejsc w każdym widocznym pociągu PKP Intercity i wszystkie potrzebne podziały trasy.",
    openGraph: {
      title: "Jedno wyszukanie. Wszystkie kombinacje.",
      description:
        "RailScout pokazuje dokładne numery wolnych miejsc na całej trasie i wszystkich potrzebnych podziałach.",
      type: "website",
      locale: "pl_PL",
      images: [
        {
          url: socialImage,
          width: 1200,
          height: 630,
          alt: "RailScout — jedno wyszukanie, wszystkie kombinacje",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "Jedno wyszukanie. Wszystkie kombinacje.",
      description:
        "Dokładne numery wolnych miejsc na całej trasie i potrzebnych podziałach.",
      images: [socialImage],
    },
    robots: {
      index: false,
      follow: false,
      noarchive: true,
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pl">
      <body className={`${bitter.variable} ${oswald.variable}`}>
        {children}
      </body>
    </html>
  );
}
