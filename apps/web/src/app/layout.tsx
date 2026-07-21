import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ScrollReveal } from "@/components/scroll-reveal";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Lunge - Agent-native advanced API client",
  description:
    "An agent-native advanced API client - execute and test REST, GraphQL, WebSocket, SSE, and gRPC requests from any MCP-capable AI agent. No GUI, token-efficient, built on a Rust core.",
  keywords: [
    "MCP",
    "Model Context Protocol",
    "API client",
    "advanced curl",
    "REST",
    "GraphQL",
    "WebSocket",
    "SSE",
    "Rust",
    "AI agents",
    "Postman alternative",
  ],
  authors: [{ name: "lunge" }],
  openGraph: {
    title: "Lunge - Agent-native advanced API client",
    description:
      "An agent-native advanced API client - execute and test REST, GraphQL, WebSocket, SSE, and gRPC requests from any MCP-capable AI agent.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`dark ${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <ScrollReveal />
        {children}
      </body>
    </html>
  );
}
