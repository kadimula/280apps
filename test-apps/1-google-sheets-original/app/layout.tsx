export const metadata = { title: "Google Sheets To-Dos" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" style={{ backgroundColor: "#071a3d", color: "#f8fafc" }}>
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          maxWidth: 480,
          margin: "48px auto",
          padding: "0 16px",
        }}
      >
        {children}
      </body>
    </html>
  );
}
