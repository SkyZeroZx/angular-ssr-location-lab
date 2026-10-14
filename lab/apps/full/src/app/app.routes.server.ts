import { RenderMode, ServerRoute } from '@angular/ssr';

// Server rendering, so redirects are answered at request time by
// createRedirectResponse. The scaffold's Prerender default never gets there.
export const serverRoutes: ServerRoute[] = [{ path: '**', renderMode: RenderMode.Server }];
