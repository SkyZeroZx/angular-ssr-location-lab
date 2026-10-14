import { RenderMode, ServerRoute } from '@angular/ssr';

// Same as the angular.dev SSR guide example: everything on Server.
export const serverRoutes: ServerRoute[] = [{ path: '**', renderMode: RenderMode.Server }];
