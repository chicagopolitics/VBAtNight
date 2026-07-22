/** @type {import('next').NextConfig} */
export default {
  serverExternalPackages: ["better-sqlite3"],
  eslint: { ignoreDuringBuilds: true },
};
