import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Google's avatar CDN, the only remote image we render. Any host not listed
    // here gets a 400 from the optimizer, which the menu shows as an initial.
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**.googleusercontent.com",
        pathname: "/**",
      },
    ],
  },
};

export default nextConfig;
