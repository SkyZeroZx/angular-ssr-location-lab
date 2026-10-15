vcl 4.1;

# Same VCL as varnish/defaults. Only http_resp_hdr_len differs (compose.yml).

import directors;
import std;
# vmod_str ships with the image; std has no strlen in 7.5.
import str;

backend app1 {
    .host = "ssr-a";
    .port = "4000";
}

backend app2 {
    .host = "ssr-b";
    .port = "4000";
}

sub vcl_init {
    new pool = directors.round_robin();
    pool.add_backend(app1);
    pool.add_backend(app2);
}

sub vcl_recv {
    set req.backend_hint = pool.backend();

    # Tag requests without logging the long URL.
    if (req.url ~ "^/home/\(x\)\?q=") {
        std.log("poc:attack");
    } else {
        std.log("poc:legit");
    }

    # No caching at all, so every legitimate request needs a live backend,
    # the same as behind nginx.
    return (pass);
}

sub vcl_backend_fetch {
    std.log("pocbe:fetch-via-director-" + bereq.backend);
}

sub vcl_backend_response {
    if (beresp.http.Location) {
        std.log("pocbe:" + beresp.backend + "-status-" + beresp.status + "-locationbytes-" +
                str.count(beresp.http.Location));
    } else {
        std.log("pocbe:" + beresp.backend + "-status-" + beresp.status + "-no-location");
    }
}

sub vcl_backend_error {
    # A header line over http_resp_hdr_len ends up here as a 503. No retry,
    # and nothing marks the backend sick.
    std.log("pocbe:fetch-failed-on-" + beresp.backend);
}
