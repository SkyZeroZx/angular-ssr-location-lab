import { Component } from '@angular/core';
import { Routes } from '@angular/router';
import { guardEncoded, guardPlain, guardTwoCopies, guardTwoEncoded } from './guards';

@Component({ selector: 'app-home', template: '<h1>home</h1>' })
export class HomePage {}

@Component({ selector: 'app-login', template: '<h1>login</h1>' })
export class LoginPage {}

@Component({ selector: 'app-protected', template: '<h1>protected</h1>' })
export class ProtectedPage {}

@Component({ selector: 'app-not-found', template: '<h1>not found</h1>' })
export class NotFoundPage {}

// One guarded route per returnUrl variant, so each factor is measured alone.
export const routes: Routes = [
  { path: '', component: HomePage },
  { path: 'home', component: HomePage },
  { path: 'auth/login', component: LoginPage },
  { path: 'amp-plain', component: ProtectedPage, canActivate: [guardPlain] },
  { path: 'amp-encoded', component: ProtectedPage, canActivate: [guardEncoded] },
  { path: 'amp-two-copies', component: ProtectedPage, canActivate: [guardTwoCopies] },
  { path: 'amp-two-encoded', component: ProtectedPage, canActivate: [guardTwoEncoded] },
  { path: '**', component: NotFoundPage },
];
