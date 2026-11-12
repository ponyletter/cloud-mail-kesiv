import worker from '../mail-worker/src/index.js';

export default {
  ...worker,
  async fetch(request, env, ctx) {
    const hasSetupAccess = Boolean(env.setup_secret)
      && request.headers.get('X-Cloud-Mail-Setup') === env.setup_secret;
    if (env.setup_mode === 'true' && !hasSetupAccess) {
      return new Response('Service setup in progress', {
        status: 503,
        headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' },
      });
    }
    if (new URL(request.url).pathname.startsWith('/api/init/') && !hasSetupAccess) {
      return new Response('Not Found', { status: 404 });
    }
    return worker.fetch(request, env, ctx);
  },
};
