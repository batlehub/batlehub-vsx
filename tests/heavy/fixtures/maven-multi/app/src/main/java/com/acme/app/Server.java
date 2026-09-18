package com.acme.app;

/**
 * Half of the type graph RFC 0012 needs: `Config` reaches `Server`, and
 * `Server` reaches an `int` and a `String`. Chain completion is the only
 * feature in the pack that needs a graph rather than a file.
 */
public class Server {
    private final int port;
    private final String host;

    public Server(String host, int port) {
        this.host = host;
        this.port = port;
    }

    public int getPort() {
        return port;
    }

    public String getHost() {
        return host;
    }
}
