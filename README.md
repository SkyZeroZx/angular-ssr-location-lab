# Angular SSR unbounded Location lab

Reproduction on `@angular/ssr` **22.2.2** with Angular 22.2.2 and Node 22.23.3, production builds served by `AngularNodeAppEngine`, behind 31 reverse proxy setups in Docker. I also reproduced it on a VPS with nginx behind Cloudflare.

`@angular/ssr` answers some redirects itself and copies request data into the `Location` header without a length limit. Percent-encoding on the way makes it larger than the request: about 3x, 5x with the usual `returnUrl` guard, and up to 14x when the app's guard also encodes the URL and copies it twice. A reverse proxy whose upstream response header buffer is smaller rejects the response with a 502, and a proxy with passive health checks counts that 502 against a healthy backend. With nginx's built-in defaults (one worker) and two backends, two of these requests leave the upstream empty and other users get 502 for about ten seconds, while both Node processes keep answering 200.

It is the same class as unpoly-rails [GHSA-m875-3xf6-mf78](https://github.com/advisories/GHSA-m875-3xf6-mf78) (CVE-2023-28846), where the request URL echoed into `X-Up-Location` made load balancers with passive health checks remove the upstream.

## Cause

[`createRedirectResponse()`](https://github.com/angular/angular-cli/blob/v22.2.2/packages/angular/ssr/src/utils/redirect.ts#L35-L73) sets the header as it gets it:

```ts
resHeaders.set("Location", location);
```

Both call sites in [`app.ts`](https://github.com/angular/angular-cli/blob/v22.2.2/packages/angular/ssr/src/app.ts) pass request data:

- Route redirects ([L168-L176](https://github.com/angular/angular-cli/blob/v22.2.2/packages/angular/ssr/src/app.ts#L168-L176)): `buildPathWithParams(redirectTo, url.pathname)` copies request path segments into a relative `redirectTo`, and `X-Forwarded-Prefix` is prepended.
- Render redirects ([L328-L329](https://github.com/angular/angular-cli/blob/v22.2.2/packages/angular/ssr/src/app.ts#L328-L329)): when the Router ends on a different URL than the request, [`ng.ts`](https://github.com/angular/angular-cli/blob/v22.2.2/packages/angular/ssr/src/utils/ng.ts#L131-L136) returns `[pathname, search, hash].join('')`, query included. This redirect comes from [#31497](https://github.com/angular/angular-cli/pull/31497).

Both redirects are intended. What's missing is a bound on the size.

The URL is percent-encoded on the way, which is correct, and these 16 characters come out as three bytes each: `new URL()` encodes `"` `'` `<` `>`, and the Router's query serializer encodes `+` `/` `=` `?` `[` `\` `]` `^` `` ` `` `{` `|` `}`. A raw `"` becomes `%22`, and `%2522` when a guard puts `state.url` in a query parameter and the Router encodes the `%` again.

## Producers

[`scripts/probe-producers.mjs`](scripts/probe-producers.mjs) sends each request straight to Node. `Q` is 1,400 raw `"`, 1,000 for A2.

|     | Path            | What the app needs                              | Request size | `Location` |
| --- | --------------- | ----------------------------------------------- | -----------: | ---------: |
| A1  | `/home/(x)?q=Q` | nothing, a Server route the normalized URL hits |      1,412 B |    4,208 B |
| A2  | `/admin?q=Q`    | a guard with `returnUrl: state.url`             |      1,009 B |    5,037 B |
| A3  | `/legacy?q=Q`   | `redirectTo: () => 'home'`                      |      1,410 B |    4,208 B |
| B1  | `/Q`            | a relative `redirectTo` under a `:lang` parent  |      1,401 B |    4,206 B |
|     | `/home?q=Q`     | control                                         |      1,408 B |   200 only |

A1 doesn't need any redirect in the app. [`lab/apps/a1only`](lab/apps/a1only/src/app/app.routes.ts) only has `''`, `'home'` and the `'**'` not found route, with every server route on `RenderMode.Server` as in the angular.dev SSR guide, and it answers `/home/(x)?q=Q`, `/.;/home?q=Q` and `/home/1//?q=Q` with a 302 of 4,208 to 4,211 bytes. The `**` route drops the unmatched `(x)` group, `new URL()` in platform-server removes the `.` the Router emits for `/.;/home`, and `Location` strips the trailing slash of `/home/1//`. The final URL no longer matches the request, and SSR redirects to it where the browser would only call `replaceState`.

## Expansion

[`lab/apps/amp`](lab/apps/amp/src/app/guards.ts) writes the `returnUrl` guard four ways:

| Guard                                      | 1,000 `"` |
| ------------------------------------------ | --------: |
| `returnUrl: state.url`                     |     4.98x |
| `returnUrl: encodeURIComponent(state.url)` |     6.94x |
| `returnUrl` and `next`                     |     9.90x |
| both with `encodeURIComponent`             |    13.83x |

Straight to Node the ceiling is Node's 16 KiB request header limit: with the last guard a 16,219 B request gave a **226,890 B** `Location`, and 17,019 B got a 431. A proxy can cap the request lower, nginx refuses request lines over 8 KB.

## Behind a proxy

Three things have to happen, and only the first one depends on Angular:

1. The `Location` is larger than the proxy's upstream response header buffer, so the proxy answers 502.
2. The proxy counts that 502 against the backend that sent the response.
3. Once every backend is counted out, the proxy fails the request instead of trying one anyway.

[`scripts/run-topology.mjs`](scripts/run-topology.mjs) runs every setup the same way: 10 legitimate requests per second to `/home` and one oversized request per second for 25 seconds, counting `/home` until it answers 200 again (at most 60 seconds after the last oversized request). Then the same run without the oversized requests as a control. Every control was 100%. Each number below is one run; repeated runs move, most for HAProxy, where five runs gave 8.9% to 40.8%.

### Affected

| Topology                                                                          | Proxy              | Legitimate `/home` |
| --------------------------------------------------------------------------------- | ------------------ | -----------------: |
| [`nginx/explicit-2peers`](lab/topologies/nginx/explicit-2peers/nginx.conf)        | nginx 1.27.5       |              16.3% |
| [`nginx/a1-isolated`](lab/topologies/nginx/a1-isolated/nginx.conf)                | nginx 1.27.5       |              15.2% |
| [`nginx/alpine-sidecar`](lab/topologies/nginx/alpine-sidecar/nginx.conf)          | nginx 1.29.3       |              10.9% |
| [`nginx/compose-2replicas`](lab/topologies/nginx/compose-2replicas/nginx.conf)    | nginx 1.31.2       |               9.5% |
| [`nginx/upstream-zone`](lab/topologies/nginx/upstream-zone/nginx.conf)            | nginx 1.27.5       |               9.3% |
| [`nginx/backup-peer`](lab/topologies/nginx/backup-peer/nginx.conf)                | nginx 1.31.2       |               9.2% |
| [`nginx/same-container`](lab/topologies/nginx/same-container/nginx.conf)          | nginx 1.30.4       |               7.6% |
| [`nginx/stock-conf`](lab/topologies/nginx/stock-conf/default.conf)                | nginx 1.27.5       |              25.2% |
| [`openresty/upstream`](lab/topologies/openresty/upstream/default.conf)            | OpenResty 1.31.1.1 |               4.8% |
| [`kong/passive-healthcheck`](lab/topologies/kong/passive-healthcheck/kong.yml)    | Kong 3.7.1         |               1.3% |
| [`caddy/passive-smallbuf`](lab/topologies/caddy/passive-smallbuf/Caddyfile)       | Caddy 2.11.7       |               7.3% |
| [`haproxy/observe-overflow`](lab/topologies/haproxy/observe-overflow/haproxy.cfg) | HAProxy 3.0.29     |              40.8% |
| [`envoy/outlier-nopanic`](lab/topologies/envoy/outlier-nopanic/envoy.yaml)        | Envoy 1.31.10      |              58.0% |

- Every nginx setup with two counted peers is affected with the default `proxy_buffer_size` and `max_fails`: an explicit `upstream`, `proxy_pass` to a Compose service with two replicas, or `proxy_pass http://localhost:4000` when `localhost` resolves to both `127.0.0.1` and `::1` (musl in `nginx:alpine`, or nginx next to Node in one container). nginx logs `upstream sent too big header`, `upstream server temporarily disabled` and then `no live upstreams` for unrelated requests, and the pool is back 7 to 8 seconds after the last oversized request. Some of these configs set `proxy_next_upstream off`, which changes nothing here because the default `error timeout` doesn't retry an invalid header either.
- `backup` doesn't help. The backup is used once the primary is out and is taken out by the next oversized response.
- These configs run one worker, nginx's built-in default, which is also what `worker_processes auto` gives on a 1 vCPU host. `stock-conf` is the official image with its `nginx.conf` as shipped and no `zone`, limited to two CPUs like a 2 vCPU VPS, so `auto` starts two workers. Each worker keeps its own failure counts, so the effect spreads thinner as workers are added: 74.8% of the legitimate requests failed with two workers, and 11.7% with the same config on all 14 CPUs of this Docker host. With a shared `zone`, as the NGINX Ingress Controller writes upstreams, every worker sees the same state (`upstream-zone`, 9.3%).
- OpenResty with a plain `upstream` behaves like nginx. Kong, built on it, keeps nginx's 4k buffer, and its passive health checker takes both targets out once 502 is added to `unhealthy.http_statuses` (its default list is `[429, 500, 503]`, and with it Kong stays at 100%). Active checks are off by default, so the targets were still out 60 seconds after the run.
- Caddy, HAProxy and Envoy do the same once the header is larger than their limit and passive checks are on: Caddy with `max_response_header 4KB`; HAProxy with `observe layer7 error-limit 1 on-error mark-down` and a ~18 KB header against its default 16 KB buffer; Envoy with outlier detection at nginx's numbers and `healthy_panic_threshold: 0`, once the header passes ~80 KiB. To get there with A1 that run raises Node's header limit to 64 KiB; at Node's default it takes a guard of 10x or more. Envoy's own 503s take about a second to close, so that run completed fewer requests than the others.

### Affected above a size

These relay the 4.2 KB header, but they still count failures:

| Topology                                                         | Relays                 | Then                                                                                |
| ---------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------- |
| [`nginx/big-buffer`](lab/topologies/nginx/big-buffer/nginx.conf) | A1 up to 24,272 B      | A2 gets a 502 from a 7,000 B request, and with `max_fails` at 1 nginx counts it too |
| [`haproxy/observe`](lab/topologies/haproxy/observe/haproxy.cfg)  | up to its 16 KB buffer | above it, `haproxy/observe-overflow`                                                |

### Not affected

Other users kept getting 200 in all of these, at any size: nothing takes a backend out on a bad response, the header limit is out of reach (the largest `Location` is about 227 KB with Node's 16 KiB request limit, against 10 MB in Caddy and Traefik), or the proxy goes back to every backend once all of them are out.

| Topology                                                                      | Oversized request | Why                                                          |
| ----------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------ |
| [`nginx/single-peer`](lab/topologies/nginx/single-peer/nginx.conf)            | 502               | nginx never disables the only server of an upstream          |
| [`nginx/max-fails-0`](lab/topologies/nginx/max-fails-0/nginx.conf)            | 502               | passive health checks off                                    |
| [`openresty/lua-balancer`](lab/topologies/openresty/lua-balancer/nginx.conf)  | 502               | Lua-selected peers are never disabled (ingress-nginx)        |
| [`haproxy/defaults`](lab/topologies/haproxy/defaults/haproxy.cfg)             | 302               | gets a 502 from a 6,000 B request, never marks a server down |
| [`caddy/defaults`](lab/topologies/caddy/defaults/Caddyfile)                   | 302               | 10 MB header limit, no passive checks                        |
| [`caddy/passive`](lab/topologies/caddy/passive/Caddyfile)                     | 302               | passive checks on, 10 MB header limit                        |
| [`traefik/defaults`](lab/topologies/traefik/defaults/dynamic.yml)             | 302               | 10 MB header limit, no passive ejection                      |
| [`traefik/circuitbreaker`](lab/topologies/traefik/circuitbreaker/dynamic.yml) | 302               | 10 MB header limit, a relayed 302 never opens the breaker    |
| [`envoy/defaults`](lab/topologies/envoy/defaults/envoy.yaml)                  | 302               | outlier detection off                                        |
| [`envoy/outlier`](lab/topologies/envoy/outlier/envoy.yaml)                    | 302               | outlier detection on, the header fits up to ~80 KiB          |
| [`envoy/outlier-overflow`](lab/topologies/envoy/outlier-overflow/envoy.yaml)  | 502               | above ~80 KiB both peers are ejected, panic mode serves      |
| [`apache/balancer`](lab/topologies/apache/balancer/httpd.conf)                | 302               | 8 KB `responsefieldsize`, no `failonstatus`                  |
| [`apache/failonstatus`](lab/topologies/apache/failonstatus/httpd.conf)        | 502               | both members in error, `forcerecovery` resets them           |
| [`varnish/defaults`](lab/topologies/varnish/defaults/default.vcl)             | 302               | backend health only comes from probes                        |
| [`varnish/hdr4k`](lab/topologies/varnish/hdr4k/compose.yml)                   | 503               | Varnish rejects it, nothing marks a backend sick             |
| [`varnish/saintmode`](lab/topologies/varnish/saintmode/default.vcl)           | 503               | saintmode can't act where the failed fetch ends              |

Where the oversized request gets 502 or 503 the header still doesn't fit; only the effect on other users is avoided.

## Smallest request

[`scripts/threshold.mjs`](scripts/threshold.mjs) binary-searches the A2 request against `nginx/compose-2replicas`, with the quotes spread over three query parameters. A 771 B request target is still relayed, with a 3,831 B `Location`, and 780 B already gets the 502. nginx accepts request lines up to 8 KB, so the request itself is nothing unusual.

## A bigger buffer is not a fix

[`scripts/escalate.mjs`](scripts/escalate.mjs) raises the request until the proxy stops relaying:

| Setup                          | Producer | Largest request accepted | Largest `Location` relayed | First rejected |
| ------------------------------ | -------- | -----------------------: | -------------------------: | -------------: |
| nginx, `proxy_buffer_size 32k` | A1       |                  8,100 B |                   24,272 B |              - |
| nginx, `proxy_buffer_size 32k` | A2       |                  8,100 B |                   29,992 B |        7,000 B |
| HAProxy, defaults              | A1       |                 15,000 B |                   14,972 B |        6,000 B |
| Caddy, defaults                | A2       |                 16,000 B |                   79,992 B |              - |

The buffer an operator would need depends on the routes of the app and changes when someone adds a login guard. To hold the last guard up to Node's 16 KiB request limit it has to fit about 227 KB of response headers.

## X-Forwarded-Prefix

A separate, smaller issue in the same path, to report on its own. [`getFirstHeaderValue()`](https://github.com/angular/angular-cli/blob/v22.2.2/packages/angular/ssr/src/utils/validation.ts#L49-L53) validates only the first comma-separated value of `X-Forwarded-Prefix` ([L223-L224](https://github.com/angular/angular-cli/blob/v22.2.2/packages/angular/ssr/src/utils/validation.ts#L223-L224)), but [`app.ts`](https://github.com/angular/angular-cli/blob/v22.2.2/packages/angular/ssr/src/app.ts#L171) and [`app-engine.ts`](https://github.com/angular/angular-cli/blob/v22.2.2/packages/angular/ssr/src/app-engine.ts#L211) use the whole header. With `NG_TRUST_PROXY_HEADERS=x-forwarded-prefix`, on the B1 redirect at `GET /xx`:

| `X-Forwarded-Prefix` | Result                                       |
| -------------------- | -------------------------------------------- |
| `/ok`                | 302, `Location: /ok/xx/home`                 |
| `/ok!!bad`           | 400                                          |
| `/ok,<7,900 B>`      | 302, 7,912 B `Location` from a 3 B target    |
| `/ok,<200 "s>`       | 302, the quotes go into `Location` unencoded |

So the buffer can be overflowed from a header with a short URL. It needs the header to be trusted, which an app behind a path-rewriting proxy has to do. The value always starts with the validated first segment, so it stays on the same origin.

## Run it

Docker and Node 20+.

```bash
npm run build             # ssr-redirect-poc:full, :a1only and :amp
npm run repro:producers   # every producer, straight to Node
node scripts/run-topology.mjs nginx/explicit-2peers
node scripts/run-topology.mjs nginx/explicit-2peers --control
node scripts/run-topology.mjs haproxy      # every setup in lab/topologies/haproxy
npm run threshold
node scripts/escalate.mjs nginx/big-buffer --producer a2
npm run repro             # build, producers, every topology and its control, about an hour
npm run clean             # containers left by an interrupted run
```

Each run writes JSON and the proxy log to `ssr-redirect-evidence/`. A topology is a folder in `lab/topologies/<proxy>/` with `compose.yml`, the proxy config and a `meta.json` with the port, the oversized request and the expected result.

The app images are a stock `ng new --ssr` with one folder of [`lab/apps`](lab/apps) copied over it. Angular and Node are pinned in the [Dockerfile](lab/apps/Dockerfile); `NG_CLI` and `NG_FRAMEWORK` override them for `npm run build`.

Node didn't crash in any run, and the 502 carries no `Location`, so nothing reaches the client.
