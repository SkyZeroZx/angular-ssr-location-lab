import { Component } from '@angular/core';
import { Routes } from '@angular/router';

@Component({ selector: 'app-home', template: '<h1>home</h1>' })
export class HomePage {}

@Component({ selector: 'app-not-found', template: '<h1>not found</h1>' })
export class NotFoundPage {}

// A1 on its own. No guard, no resolver, no redirectTo and no :param route,
// only the not-found wildcard most apps have. Any redirect from this app is
// the router normalizing the URL, not something the app asked for.
export const routes: Routes = [
  { path: '', component: HomePage },
  { path: 'home', component: HomePage },
  { path: '**', component: NotFoundPage },
];
