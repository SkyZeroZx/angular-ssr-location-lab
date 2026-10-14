import { Component } from '@angular/core';
import { Routes } from '@angular/router';
import { authGuard } from './auth.guard';

@Component({ selector: 'app-home', template: '<h1>home</h1>' })
export class HomePage {}

@Component({ selector: 'app-login', template: '<h1>login</h1>' })
export class LoginPage {}

@Component({ selector: 'app-admin', template: '<h1>admin</h1>' })
export class AdminPage {}

@Component({ selector: 'app-not-found', template: '<h1>not found</h1>' })
export class NotFoundPage {}

// The four published producers in one app. Every topology runs on this image.
//
//   A1  /home/(x)?q=...  router URL normalization, needs the Server `**` route
//   A2  /admin?q=...     guard that copies the current URL into returnUrl
//   A3  /legacy?q=...    functional relative redirectTo keeps the query
//   B1  /<segment>       relative redirect under a :param parent
export const routes: Routes = [
  { path: '', component: HomePage },
  { path: 'home', component: HomePage },
  { path: 'auth/login', component: LoginPage },
  { path: 'admin', component: AdminPage, canActivate: [authGuard] },
  { path: 'legacy', redirectTo: () => 'home' },
  {
    path: ':lang',
    children: [
      { path: '', redirectTo: 'home', pathMatch: 'full' },
      { path: 'home', component: HomePage },
    ],
  },
  { path: '**', component: NotFoundPage },
];
