import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/polyhaven-api': {
        target: 'https://api.polyhaven.com',
        changeOrigin: true,
        secure: true,
        rewrite: path => path.replace(/^\/polyhaven-api/, ''),
        headers: {
          'User-Agent': 'CreationEnvironmentStudio/1.0'
        }
      }
    }
  }
});
