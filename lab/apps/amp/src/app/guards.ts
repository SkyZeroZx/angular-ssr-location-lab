import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

// The returnUrl guard written four ways. Each one adds an encoding layer or a
// second copy of the URL, and the Location grows with it. The largest factor
// is what a proxy buffer would have to cover.

// One copy: `"` -> %22 -> %2522, 5x.
export const guardPlain: CanActivateFn = (_route, state) =>
  inject(Router).createUrlTree(['/auth/login'], {
    queryParams: { returnUrl: state.url },
  });

// One copy, encoded by the app before the router encodes it again, 7x.
export const guardEncoded: CanActivateFn = (_route, state) =>
  inject(Router).createUrlTree(['/auth/login'], {
    queryParams: { returnUrl: encodeURIComponent(state.url) },
  });

// Two copies, for apps that keep both a returnUrl and a next, 10x.
export const guardTwoCopies: CanActivateFn = (_route, state) =>
  inject(Router).createUrlTree(['/auth/login'], {
    queryParams: { returnUrl: state.url, next: state.url },
  });

// Two copies, both encoded by the app, 14x.
export const guardTwoEncoded: CanActivateFn = (_route, state) =>
  inject(Router).createUrlTree(['/auth/login'], {
    queryParams: {
      returnUrl: encodeURIComponent(state.url),
      next: encodeURIComponent(state.url),
    },
  });
