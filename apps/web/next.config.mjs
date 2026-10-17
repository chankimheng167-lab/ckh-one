/** Static export: the app shell is plain files, so the service worker can cache it and the app opens offline. */
const config = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ['@ckh/shared'],
  reactStrictMode: true,
};
export default config;
