import type { ReactNode } from "react";
import "./styles.css";

export const metadata = { title: "Logic SDK × Next.js" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
