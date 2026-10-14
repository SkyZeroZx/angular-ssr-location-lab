import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

// Producer A2, the usual returnUrl guard. The lab never authenticates, so
// every visit is redirected to the login page with the current URL attached.
//
// state.url is already serialized (a raw `"` is `%22`), and the router encodes
// it again as a query value (`%2522`), so one request byte becomes five.
export const authGuard: CanActivateFn = (_route, state) =>
  inject(Router).createUrlTree(['/auth/login'], {
    queryParams: { returnUrl: state.url },
  });
