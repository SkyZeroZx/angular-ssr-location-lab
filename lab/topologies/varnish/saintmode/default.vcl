vcl 4.1;

# The varnish VCL plus vmod_saintmode, Varnish's opt-in way to take a backend
# out after failed fetches, with a threshold of 1.
#
# It never takes effect here. saintmode.blacklist() is only allowed in
# vcl_backend_response, and a response whose header does not fit never gets
# there: it ends in vcl_backend_error, where the call fails with
#   VCL_Error  saintmode.denylist() called outside of vcl_backend_response
# Calling it from vcl_backend_response on a normal 302 does take both
# backends out, so the module itself works in this image.

import directors;
import saintmode;
import std;
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
    new sm1 = saintmode.saintmode(app1, 1);
    new sm2 = saintmode.saintmode(app2, 1);

    new pool = directors.round_robin();
    pool.add_backend(sm1.backend());
    pool.add_backend(sm2.backend());
}

sub vcl_recv {
    set req.backend_hint = pool.backend();

    if (req.url ~ "^/home/\(x\)\?q=") {
        std.log("poc:attack");
    } else {
        std.log("poc:legit");
    }

    return (pass);
}

sub vcl_backend_fetch {
    std.log("pocbe:fetch-via-director-" + bereq.backend);
}

sub vcl_backend_response {
    if (beresp.http.Location) {
        std.log("pocbe:" + beresp.backend + "-status-" + beresp.status +
                "-locationbytes-" + str.count(beresp.http.Location));
    } else {
        std.log("pocbe:" + beresp.backend + "-status-" + beresp.status +
                "-no-location");
    }
}

sub vcl_backend_error {
    saintmode.blacklist(10s);
    std.log("pocbe:blacklisted-" + beresp.backend + "-for-10s");
}
