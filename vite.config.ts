import { defineConfig, loadEnv } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { resolve } from 'node:path';

// Vite serves the browser pages in dev and builds them for production.
// Phones talk to the Vite dev server; Vite forwards /socket.io and /health to the Node server.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const serverPort = Number(env.PORT ?? 3000);
  const useHttps = env.DEV_HTTPS === 'true';

  return {
    root: 'client',
    // Read .env from the project root, not client/ (Vite looks next to `root` by default),
    // so VITE_PUBLIC_URL reaches the browser code.
    envDir: process.cwd(),
    plugins: useHttps ? [basicSsl()] : [],
    server: {
      host: true, // listen on the LAN, not just localhost, so phones can reach it
      port: Number(env.CLIENT_PORT ?? 5173),
      strictPort: true,
      // Allow tunnel hostnames (cloudflared / ngrok) as well as LAN IPs.
      allowedHosts: ['.trycloudflare.com', '.ngrok-free.app', '.ngrok.app', 'localhost'],
      proxy: {
        '/socket.io': { target: `http://localhost:${serverPort}`, ws: true },
        '/health': { target: `http://localhost:${serverPort}` },
        '/info': { target: `http://localhost:${serverPort}` },
      },
    },
    build: {
      outDir: resolve(process.cwd(), 'dist/client'),
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: resolve(process.cwd(), 'client/index.html'),
          host: resolve(process.cwd(), 'client/host.html'),
          phone: resolve(process.cwd(), 'client/phone.html'),
        },
      },
    },
  };
});
